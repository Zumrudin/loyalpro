# Детерминированные защиты агента Милы: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перенести самые ошибкоопасные обязанности LLM (оформление цепочек записей, форматирование цен, сверку времени, стилевые табу) в детерминированный код и устранить противоречия в системном промпте.

**Architecture:** Три слоя. (1) Слой данных — каталог и инструменты отдают готовые к показу значения (цены, `option_id` вариантов стыковки), модель копирует, а не вычисляет. (2) Слой guard'ов — оркестратор/диспетчер линтуют финальную реплику (время не из слотов, слова-табу, утечка id, повторное приветствие) и гарантируют фразу перевода при эскалации. (3) Слой промпта — правила, ставшие ложными в catalog-режиме, получают режимозависимые варианты; ценовые правила консолидируются.

**Tech Stack:** Node.js/Express, jest 30 (`npx jest <pattern>` из `backend/`), без ORM. Все тесты агента — `backend/agent-*.test.js`, паттерн внедрения зависимостей — четвёртый аргумент/`opts.deps` (как в `dispatcher.js`/`orchestrator.js`).

**Ключевые ограничения (из CLAUDE.md и памяти проекта):**
- Промпт защищён тестами `agent-system-prompt.test.js` — после КАЖДОЙ правки промпта гонять `npx jest agent-system-prompt`. Не срезать выверенные формулировки, только переносить инвариант в код.
- Блок каталога в промпте обязан быть детерминированным (префикс-кэш провайдера).
- Дев-сервер (`pm2 restart loyalpro`) требует рестарта, чтобы подхватить правки агента.
- `list-services.js` не удалять — guard'ы зовут его напрямую.

---

## Порядок задач

| # | Задача | Риск | Зависит от |
|---|--------|------|-----------|
| 1 | Цены в данных: `fmtPrice` точная цена + заглушки «инд.» | низкий | — |
| 2 | `get_service_masters`: готовые строки цен | низкий | 1 |
| 3 | `reply-guard.js`: чистые линт-хелперы | низкий | — |
| 4 | Оркестратор: подключение reply-guard (лог + 1 переписывание) | средний | 3 |
| 5 | Диспетчер: гарантия фразы перевода при эскалации | низкий | — |
| 6 | `sequential-offers.js`: кэш предложенных вариантов | низкий | — |
| 7 | `get_sequential_slots`: `option_id` в выдаче | низкий | 6 |
| 8 | Инструмент `book_chain` + флаги оркестратора | высокий | 6, 7 |
| 9 | Промпт: стыковка через `book_chain` | средний | 8 |
| 10 | Промпт: режимозависимые правила фактов | средний | — |
| 11 | Промпт: консолидация ценовых правил | средний | 1 |
| 12 | Промпт: шаблоны первого сообщения по identity-случаям | низкий | — |
| 13 | Финальная проверка: полный прогон, рестарт дев, E2E | — | все |

---

### Task 1: Цены в данных — `fmtPrice` без ложного «от», заглушки скрыты

Правило промпта «цену называй точно, без "от"» противоречит рендеру каталога: `fmtPrice` при `price_max:0` пишет `от X`. Модель вынуждена в уме переворачивать формат. Переносим решение в код: `price_max:0` → точная цена; цена-заглушка (≤ 100 ₽ — у обобщённых услуг типа «Биоревитализация» стоит 1 ₽) → маркер `инд.`, чтобы модель физически не видела «1 ₽».

**Files:**
- Modify: `backend/services/agent/catalog-block.js` (функция `fmtPrice`, заголовок блока)
- Modify: `backend/services/agent/system-prompt.js` (легенда цен в `CATALOG_SOURCE_RULE`)
- Test: `backend/agent-catalog-block.test.js`

- [ ] **Step 1: Прочитать существующие тесты**

Прочитай `backend/agent-catalog-block.test.js` целиком — там уже есть ассерты на `fmtPrice` и заголовок блока, которые изменятся.

- [ ] **Step 2: Написать падающие тесты на новый `fmtPrice`**

Добавь в `backend/agent-catalog-block.test.js` (в существующий `describe` про `fmtPrice`, либо новый):

```js
describe('fmtPrice: точная цена и заглушки (2026-07-29)', () => {
  const { fmtPrice } = require('./services/agent/catalog-block');

  test('price_max:0 — точная цена, БЕЗ «от»', () => {
    expect(fmtPrice(6500, 0)).toBe('6500');
  });

  test('price_max < price_min (мусорные данные) — точная цена по price_min', () => {
    expect(fmtPrice(6500, 100)).toBe('6500');
  });

  test('реальный диапазон сохраняется', () => {
    expect(fmtPrice(3000, 5000)).toBe('3000-5000');
  });

  test('равные границы — одно число', () => {
    expect(fmtPrice(3000, 3000)).toBe('3000');
  });

  test('цена-заглушка (≤100 ₽, без верхней границы) — маркер «инд.»', () => {
    expect(fmtPrice(1, 0)).toBe('инд.');
    expect(fmtPrice(100, 0)).toBe('инд.');
  });

  test('нет цены вовсе — пустая строка', () => {
    expect(fmtPrice(0, 0)).toBe('');
  });
});
```

- [ ] **Step 3: Прогнать — убедиться, что падают**

Run: `cd /root/loyalpro/backend && npx jest agent-catalog-block`
Expected: FAIL — `fmtPrice(6500, 0)` сейчас возвращает `'от 6500'`, `fmtPrice(1, 0)` → `'от 1'`.

- [ ] **Step 4: Реализовать `fmtPrice`**

В `backend/services/agent/catalog-block.js` замени функцию `fmtPrice`:

```js
// Цена-заглушка обобщённых услуг («Биоревитализация» = 1 ₽): реальную стоимость
// определяет врач по препарату. Показывать её пациенту нельзя — рендерим «инд.»,
// чтобы модель физически не видела 1 ₽ (раньше это правило жило только в промпте).
const PLACEHOLDER_PRICE_MAX = 100;

function fmtPrice(min, max) {
  const lo = Number(min) || 0;
  const hi = Number(max) || 0;
  if (!lo && !hi) return '';
  if (!lo) return String(hi);
  // price_max:0 в YClients — НЕ «без верхней границы», а незаполненное поле:
  // price_min и есть фактическая цена (правило «точная цена без "от"», df1f426).
  if (!hi || hi <= lo) {
    return lo <= PLACEHOLDER_PRICE_MAX ? 'инд.' : String(lo);
  }
  return `${lo}-${hi}`;
}
```

- [ ] **Step 5: Обновить заголовок блока каталога**

В `renderCatalogBlock` замени строку заголовка:

```js
'КАТАЛОГ УСЛУГ КЛИНИКИ (полный актуальный список; формат строки: id услуги|название|длительность в минутах|цена ₽|направление>подкатегория|id мастеров через запятую). Цена: одно число — точная стоимость; X-Y — диапазон по мастерам; «инд.» — стоимость определяет врач на консультации, цифру НЕ называй; пусто — цены нет, не выдумывай:',
```

- [ ] **Step 6: Обновить легенду цен в `CATALOG_SOURCE_RULE`**

В `backend/services/agent/system-prompt.js` в константе `CATALOG_SOURCE_RULE` замени фрагмент:

```
'price_min/price_max — колонка «цена ₽» (одно число — точная цена, «X-Y» — диапазон по мастерам, «от X» — стартовая цена без верхней границы); '
```

на:

```
'price_min/price_max — колонка «цена ₽» (одно число — точная цена, «X-Y» — диапазон по мастерам, «инд.» — стоимость определяет врач, цифру не называть); '
```

- [ ] **Step 7: Прогнать тесты каталога и промпта**

Run: `cd /root/loyalpro/backend && npx jest agent-catalog-block agent-system-prompt`
Expected: PASS. Если в `agent-system-prompt.test.js` или `agent-catalog-block.test.js` есть ассерты на старую фразу `«от X» — стартовая цена` или на `'от 6500'` — обнови их на новые формулировки из шагов 4–6 (смысл теста сохраняй, меняй только ожидаемую строку).

- [ ] **Step 8: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/catalog-block.js backend/services/agent/system-prompt.js backend/agent-catalog-block.test.js
git commit -m "feat(agent): цены каталога форматирует код — точная цена без «от», заглушки скрыты как «инд.»"
```

---

### Task 2: `get_service_masters` — готовые строки цен по мастерам

Модель не должна собирать «у Юлии — 3 000 ₽» из сырых `price_min/price_max` — инструмент отдаёт готовую строку `price_display` по той же логике `fmtPrice`.

**Files:**
- Modify: `backend/services/agent/tools/get-service-masters.js`
- Test: `backend/agent-tools.test.js`

- [ ] **Step 1: Написать падающий тест**

Найди в `backend/agent-tools.test.js` существующий блок тестов `get_service_masters` (поиск по `get-service-masters` или `get_service_masters`) и посмотри, как там мокается `loadCatalogServices` (jest.mock модуля `../catalog-data` или инъекция). Добавь тест рядом, в том же стиле мока:

```js
test('get_service_masters: каждый мастер получает готовую строку price_display', async () => {
  // catalog-data мокнут так же, как в соседних тестах этого блока:
  // услуга yc_id=101 с мастерами
  //   { yc_id: 1, name: 'Юлия', price_min: 3000, price_max: 0 }
  //   { yc_id: 2, name: 'Пери Исамудиновна', price_min: 5000, price_max: 8000 }
  const res = await svcMasters.run(1, { service_yc_ids: [101] });
  const staff = res.services[0].staff;
  expect(staff[0].price_display).toBe('3000 ₽');
  expect(staff[1].price_display).toBe('5000-8000 ₽');
});
```

(Если в соседних тестах мок каталога устроен иначе — повтори их устройство; суть ассерта не меняй: `price_display` = `'3000 ₽'` для точной цены и `'5000-8000 ₽'` для диапазона.)

- [ ] **Step 2: Прогнать — убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest agent-tools -t "price_display"`
Expected: FAIL — `price_display` undefined.

- [ ] **Step 3: Реализовать**

В `backend/services/agent/tools/get-service-masters.js`:

```js
const { fmtPrice } = require('../catalog-block');
```

и в `run` замени сборку `services.push(...)`:

```js
if (s) {
  const staff = (s.staff || []).map(m => ({
    ...m,
    // Готовая строка для показа пациенту — модель копирует, а не форматирует
    // сырые price_min/price_max (источник ошибок «от 6500 ₽» и «6500–0»).
    price_display: (() => {
      const p = fmtPrice(m.price_min, m.price_max);
      return p ? `${p} ₽` : '';
    })(),
  }));
  services.push({ yc_id: s.yc_id, title: s.title, duration_min: s.duration_min, staff });
} else notFound.push(id);
```

И дополни `description` схемы (после первого предложения):

```
'В поле price_display каждого мастера — готовая строка цены: называй её пациенту дословно. '
```

- [ ] **Step 4: Прогнать**

Run: `cd /root/loyalpro/backend && npx jest agent-tools`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/tools/get-service-masters.js backend/agent-tools.test.js
git commit -m "feat(agent): get_service_masters отдаёт готовую строку price_display на каждого мастера"
```

---

### Task 3: `reply-guard.js` — чистые линт-хелперы финальной реплики

Чистый модуль без БД/HTTP (как `agent-gate.js`, `sequential.js`): извлечение времён, сбор допустимых времён, линт реплики. Оркестратор подключит его в Task 4.

**Files:**
- Create: `backend/services/agent/reply-guard.js`
- Test: `backend/agent-reply-guard.test.js`

- [ ] **Step 1: Написать падающие тесты**

Создай `backend/agent-reply-guard.test.js`:

```js
'use strict';

const g = require('./services/agent/reply-guard');

describe('extractTimes', () => {
  test('вытаскивает HH:MM и HH.MM, нормализует к HH:MM', () => {
    expect(g.extractTimes('могу предложить 14:00 или 16.30')).toEqual(['14:00', '16:30']);
  });
  test('однозначный час нормализуется с ведущим нулём', () => {
    expect(g.extractTimes('в 9:30 утра')).toEqual(['09:30']);
  });
  test('без времени — пустой массив', () => {
    expect(g.extractTimes('запишу вас на чистку')).toEqual([]);
  });
});

describe('checkOfferedTimes', () => {
  test('все времена реплики есть в allowed — нет нарушений', () => {
    const v = g.checkOfferedTimes('окошки в 14:00 или 16:30', new Set(['14:00', '16:30']));
    expect(v).toEqual([]);
  });
  test('время не из allowed — нарушение unknown_time', () => {
    const v = g.checkOfferedTimes('могу в 15:00', new Set(['14:00']));
    expect(v).toEqual([{ type: 'unknown_time', value: '15:00' }]);
  });
  test('пустой allowed — проверка отключена (за ход время не всплывало)', () => {
    expect(g.checkOfferedTimes('в 15:00', new Set())).toEqual([]);
  });
});

describe('lintReply', () => {
  test('слова-табу — нарушение taboo_word (value = слово как в тексте, в нижнем регистре)', () => {
    const v = g.lintReply('посмотрела в нашем Каталоге и прайсе');
    expect(v).toEqual(expect.arrayContaining([
      { type: 'taboo_word', value: 'каталоге' },
      { type: 'taboo_word', value: 'прайсе' },
    ]));
  });
  test('«база знаний» в любом падеже', () => {
    expect(g.lintReply('в базе знаний нет статьи')).toEqual(
      expect.arrayContaining([{ type: 'taboo_word', value: 'базе знаний' }]));
  });
  test('утечка внутреннего id (6+ цифр подряд)', () => {
    expect(g.lintReply('ваша запись 15234567 создана')).toEqual(
      expect.arrayContaining([{ type: 'id_leak', value: '15234567' }]));
  });
  test('телефон в формате +7…/8… НЕ считается утечкой id', () => {
    expect(g.lintReply('наберите нас: +79200255591')).toEqual([]);
    expect(g.lintReply('наберите нас: 89200255591')).toEqual([]);
  });
  test('цена с пробелом-разделителем не триггерит id_leak', () => {
    expect(g.lintReply('стоимость 6 500 ₽')).toEqual([]);
  });
  test('повторное приветствие при hasPriorAssistant', () => {
    expect(g.lintReply('Здравствуйте! Записать вас?', { hasPriorAssistant: true }))
      .toEqual(expect.arrayContaining([{ type: 'repeat_greeting', value: 'Здравствуйте' }]));
  });
  test('приветствие в ПЕРВОМ ответе — норма', () => {
    expect(g.lintReply('Здравствуйте! Я Мила', { hasPriorAssistant: false })).toEqual([]);
  });
  test('больше одного эмодзи — emoji_excess', () => {
    expect(g.lintReply('Готово! ✅ Ждём вас 🤍🌸')).toEqual(
      expect.arrayContaining([{ type: 'emoji_excess', value: '3' }]));
    expect(g.lintReply('Ждём вас 🤍')).toEqual([]);
  });
  test('чистая реплика — пусто', () => {
    expect(g.lintReply('Записала вас на чистку лица, будем ждать')).toEqual([]);
  });
});

describe('hardViolations', () => {
  test('taboo_word и id_leak — жёсткие (требуют переписывания)', () => {
    expect(g.hardViolations([
      { type: 'taboo_word', value: 'прайс' },
      { type: 'emoji_excess', value: '2' },
    ])).toEqual([{ type: 'taboo_word', value: 'прайс' }]);
  });
});
```

- [ ] **Step 2: Прогнать — модуля нет**

Run: `cd /root/loyalpro/backend && npx jest agent-reply-guard`
Expected: FAIL — `Cannot find module './services/agent/reply-guard'`.

- [ ] **Step 3: Реализовать `reply-guard.js`**

Создай `backend/services/agent/reply-guard.js`:

```js
'use strict';

// ── Линт финальной реплики агента. Чистые функции — без БД/HTTP. ────────────
// Детерминированная страховка промпт-правил, которые модель периодически
// нарушает: время не из slots (инцидент 2026-07-28), слова-табу и внутренние
// id (правило 9), повторное приветствие, перебор эмодзи. Оркестратор по
// жёстким нарушениям делает ОДИН корректирующий довызов, остальное — лог.

const TIME_RE = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g;

// Внутренняя кухня (правило 9 промпта). «система» намеренно не в списке —
// слишком много ложных срабатываний («систематический уход»).
const TABOO_RE = /(каталог\w*|прайс\w*|баз[аеуы]\s+знаний|нет\s+статьи|системн\w+\s+промпт|промпт\w*)/gi;

// 6+ цифр подряд = похоже на yc_id/record_id. Телефоны (+7…/8… на 11 цифр)
// и цены с разделителем-пробелом под это не попадают.
const ID_LEAK_RE = /(?<![\d+])\d{6,}\b/g;
const PHONE_RE = /(?:\+7|\b[78])\d{10}\b/g;

const GREETING_RE = /(здравствуйте|добрый\s+(день|вечер|утро)|доброе\s+утро)/i;

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

// Нормализованные HH:MM из текста (14.30 → 14:30, 9:30 → 09:30).
function extractTimes(text) {
  const out = [];
  for (const m of String(text || '').matchAll(TIME_RE)) {
    out.push(`${m[1].padStart(2, '0')}:${m[2]}`);
  }
  return out;
}

// Времена реплики должны входить в allowed (Set строк HH:MM). Пустой allowed —
// проверка выключена: за ход время нигде не всплывало, сверять не с чем.
function checkOfferedTimes(text, allowed) {
  if (!allowed || !allowed.size) return [];
  const out = [];
  for (const t of extractTimes(text)) {
    if (!allowed.has(t)) out.push({ type: 'unknown_time', value: t });
  }
  return out;
}

function lintReply(text, opts = {}) {
  const s = String(text || '');
  const out = [];
  for (const m of s.matchAll(TABOO_RE)) out.push({ type: 'taboo_word', value: m[1].toLowerCase() });
  const noPhones = s.replace(PHONE_RE, '');
  for (const m of noPhones.matchAll(ID_LEAK_RE)) out.push({ type: 'id_leak', value: m[0] });
  if (opts.hasPriorAssistant) {
    const g = s.match(GREETING_RE);
    if (g) out.push({ type: 'repeat_greeting', value: g[1][0].toUpperCase() + g[1].slice(1) });
  }
  const emoji = s.match(EMOJI_RE);
  if (emoji && emoji.length > 1) out.push({ type: 'emoji_excess', value: String(emoji.length) });
  return out;
}

// Жёсткие нарушения — раскрытие внутренней кухни. По ним оркестратор просит
// модель переписать ответ; стилистика (эмодзи, приветствие) — только лог.
const HARD_TYPES = new Set(['taboo_word', 'id_leak']);
function hardViolations(violations) {
  return (violations || []).filter(v => HARD_TYPES.has(v.type));
}

module.exports = { extractTimes, checkOfferedTimes, lintReply, hardViolations };
```

- [ ] **Step 4: Прогнать**

Run: `cd /root/loyalpro/backend && npx jest agent-reply-guard`
Expected: PASS (13 тестов). Если тест «Здравствуйте» падает из-за регистра `value` — приведи ассерт и реализацию к одному виду (нормализуй `value` через `toLowerCase()` в обоих местах, это допустимая правка теста).

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/reply-guard.js backend/agent-reply-guard.test.js
git commit -m "feat(agent): reply-guard — чистые линт-хелперы финальной реплики (время, табу, id, приветствие, эмодзи)"
```

---

### Task 4: Оркестратор — подключение reply-guard

Собираем допустимые времена (результаты инструментов + история + текущее время из промпта), линтуем финальные реплики. `unknown_time` и стилистика — **только лог** (сначала меряем false positives). Жёсткие нарушения (табу/id) — один корректирующий довызов без инструментов.

**Files:**
- Modify: `backend/services/agent/orchestrator.js`
- Test: `backend/agent-orchestrator.test.js`

- [ ] **Step 1: Изучить устройство тестов оркестратора**

Прочитай `backend/agent-orchestrator.test.js`: там мокается `provider` (очередь ответов `createMessage`), `history`, `state` через `opts.deps`. Новые тесты пиши в том же стиле.

- [ ] **Step 2: Написать падающие тесты**

Добавь в `backend/agent-orchestrator.test.js` (используя фабрики моков этого файла; ниже — суть, оформи по образцу соседних тестов):

```js
describe('reply-guard в оркестраторе (2026-07-29)', () => {
  test('жёсткое нарушение (слово-табу) → один корректирующий довызов, отдаётся переписанная реплика', async () => {
    // provider: 1-й ответ — финальный текст «Посмотрела в нашем прайсе, чистка 6500 ₽»,
    // 2-й ответ (корректирующий) — «Чистка лица стоит 6500 ₽».
    const res = await runDialogWithMocks(/* provider с двумя ответами */);
    expect(res.replies).toEqual(['Чистка лица стоит 6500 ₽']);
    // корректирующий вызов ушёл БЕЗ инструментов
    expect(providerMock.calls[1].tools).toEqual([]);
  });

  test('переписанная реплика всё ещё грязная → отдаём её как есть (без второго ретрая)', async () => {
    // оба ответа провайдера содержат «прайс» — второй раз не переписываем
    const res = await runDialogWithMocks(/* ... */);
    expect(res.replies.length).toBe(1);
    expect(providerMock.calls.length).toBe(2); // ровно один ретрай
  });

  test('unknown_time НЕ переписывается (лог-only): реплика с временем не из слотов доставляется', async () => {
    // ход: get_available_slots вернул slots [{time:'14:30',…}], финальная реплика «могу в 15:00»
    const res = await runDialogWithMocks(/* ... */);
    expect(res.replies).toEqual(['могу предложить 15:00']);
  });

  test('время, названное клиентом в истории, не считается unknown_time (нет ретрая)', async () => {
    // history: user-сообщение «хочу на 15:00», реплика повторяет 15:00 → 1 вызов провайдера
  });
});
```

- [ ] **Step 3: Прогнать — убедиться, что падают**

Run: `cd /root/loyalpro/backend && npx jest agent-orchestrator -t "reply-guard"`
Expected: FAIL.

- [ ] **Step 4: Реализовать в `orchestrator.js`**

4a. Вверху файла:

```js
const replyGuard = require('./reply-guard');
```

4b. В начале итерации `attempt` (после `const convo = messages.slice();`) добавь сбор допустимых времён и флага приветствия:

```js
    // Допустимые времена для финальной реплики: всё, что реально всплывало в
    // этом ходе — история диалога (клиент сам называл время / мы уже предлагали),
    // текущее время из промпта и результаты инструментов (пополняется ниже).
    // Сверка — детерминированная страховка правила «время дословно из slots»
    // (инцидент 2026-07-28: выдуманное 14:00). Пока ТОЛЬКО лог — меряем шум.
    const allowedTimes = new Set(replyGuard.extractTimes(JSON.stringify(messages)));
    for (const t of replyGuard.extractTimes(system)) allowedTimes.add(t);
    const hasPriorAssistant = messages.some(m => m.role === 'assistant');
```

4c. В цикле обработки tool-результатов (после `results.push({ id: tc.id, name: tc.name, result, isError });`) добавь:

```js
        for (const t of replyGuard.extractTimes(JSON.stringify(result))) allowedTimes.add(t);
```

4d. После цикла итераций, СРАЗУ после блока `degradedAfterWrite && replies.length === 0` (реплика уже финальна), добавь линт:

```js
    // ── Линт финальной реплики (reply-guard) ──
    if (replies.length && !degradedAfterWrite) {
      const joined = replies.join('\n');
      const violations = [
        ...replyGuard.lintReply(joined, { hasPriorAssistant }),
        ...replyGuard.checkOfferedTimes(joined, allowedTimes),
      ];
      if (violations.length) {
        logger.warn(`dialog ${dialogKey}: reply-guard: ${JSON.stringify(violations)}`);
      }
      const hard = replyGuard.hardViolations(violations);
      if (hard.length) {
        // ОДИН корректирующий довызов без инструментов: убрать внутреннюю кухню,
        // сохранив смысл. Второй раз не переписываем — доставляем как есть (лог уже был).
        try {
          const fix = await provider.createMessage({
            system,
            messages: convo.concat([{
              role: 'user',
              content: 'СЛУЖЕБНАЯ ПРОВЕРКА (пациент этого не видит): твой последний ответ ' +
                `содержит внутренние термины или идентификаторы: ${hard.map(v => v.value).join(', ')}. ` +
                'Перепиши его для пациента тем же смыслом, но без этих слов и чисел. ' +
                'В ответе — ТОЛЬКО переписанный текст.',
            }]),
            tools: [],
          }, { client: opts.client });
          if (fix.text) { replies.length = 0; replies.push(fix.text); }
        } catch (e) {
          logger.warn(`dialog ${dialogKey}: корректирующий довызов не удался (${e.message}) — отдаю исходную реплику`);
        }
      }
    }
```

**Важно:** блок стоит ДО вычисления `falseSuccess`/`bookingFailRecoverable` (они читают `allReplies` — объявление `const allReplies = replies.join('\n')` должно остаться ниже этого блока).

- [ ] **Step 5: Прогнать оркестратор целиком**

Run: `cd /root/loyalpro/backend && npx jest agent-orchestrator agent-false-success`
Expected: PASS — и новые, и старые тесты (корректирующий довызов не должен ломать сценарии falseSuccess: там реплики без слов-табу).

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/orchestrator.js backend/agent-orchestrator.test.js
git commit -m "feat(agent): линт финальной реплики в оркестраторе — лог времени не из слотов, одно переписывание при утечке внутренней кухни"
```

---

### Task 5: Диспетчер — гарантия фразы перевода при эскалации

Сейчас `DEFAULT_HANDOVER_TEXT` уходит только если модель эскалировала молча. Гарантируем инвариант: при свежей эскалации клиент ВСЕГДА слышит про администратора — если ни одна реплика модели не упоминает перевод, добавляем стандартную фразу.

**Files:**
- Modify: `backend/services/agent/dispatcher.js`
- Test: `backend/agent-dispatcher.test.js`

- [ ] **Step 1: Написать падающий тест**

В `backend/agent-dispatcher.test.js` (по образцу соседних тестов с моками `orchestrator`/`send`):

```js
test('эскалация с репликой БЕЗ упоминания администратора → фраза перевода добавляется', async () => {
  // orchestrator.runDialog → { replies: ['Спасибо, что предупредили!'], escalated: true, sideEffect: true }
  await dispatcher.process(1, 'dlg', meta, { settings, orchestrator, send, escalate });
  expect(sent).toEqual([
    'Спасибо, что предупредили!',
    expect.stringContaining('администратору'),
  ]);
});

test('эскалация с репликой, где перевод уже объявлен → ничего не добавляем', async () => {
  // replies: ['Передаю ваш диалог администратору клиники — он подключится с минуты на минуту 🤍']
  await dispatcher.process(1, 'dlg', meta, { settings, orchestrator, send, escalate });
  expect(sent.length).toBe(1);
});
```

- [ ] **Step 2: Прогнать — убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest agent-dispatcher -t "эскалация"`
Expected: первый тест FAIL (сейчас уходит только реплика модели).

- [ ] **Step 3: Реализовать**

В `dispatcher.js` замени ветку `} else if (res.escalated && replies.length === 0) {`:

```js
      } else if (res.escalated) {
        // Свежая эскалация: клиент ОБЯЗАН услышать про перевод на администратора.
        // Модель могла ответить по делу («Спасибо, что предупредили»), но забыть
        // объявить перевод — тогда добавляем стандартную фразу детерминированно.
        for (const text of replies) await send(meta, text);
        const announced = replies.some(t => /администратор/i.test(t));
        if (!announced) await send(meta, DEFAULT_HANDOVER_TEXT);
      } else if (replies.length === 0) {
```

(Старая ветка `res.escalated && replies.length === 0` покрывается новой: `replies` пуст → цикл не шлёт ничего, `announced` false → уходит `DEFAULT_HANDOVER_TEXT`.)

- [ ] **Step 4: Прогнать диспетчер целиком**

Run: `cd /root/loyalpro/backend && npx jest agent-dispatcher`
Expected: PASS, включая старый тест «эскалация без реплик → DEFAULT_HANDOVER_TEXT».

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/dispatcher.js backend/agent-dispatcher.test.js
git commit -m "feat(agent): при эскалации фраза перевода гарантируется диспетчером, а не промптом"
```

---

### Task 6: `sequential-offers.js` — кэш предложенных вариантов стыковки

In-memory кэш «`option_id` → цепочка» на диалог (один PM2-процесс — паттерн диспетчера). `get_sequential_slots` кладёт, `book_chain` берёт. TTL 30 минут; потеря кэша (рестарт) — восстановимая ошибка «вариант устарел».

**Files:**
- Create: `backend/services/agent/sequential-offers.js`
- Test: `backend/agent-sequential-offers.test.js`

- [ ] **Step 1: Написать падающие тесты**

Создай `backend/agent-sequential-offers.test.js`:

```js
'use strict';

const offers = require('./services/agent/sequential-offers');

beforeEach(() => offers._reset());

const CHAIN = [{ service_yc_id: 101, staff_yc_id: 7, datetime: '2026-07-30T14:00:00+03:00', seance_length: 3600 }];

test('remember/take: вариант возвращается по option_id', () => {
  offers.remember(1, 'dlg', { o1: { chain: CHAIN, booking_mode: 'separate_records' } });
  expect(offers.take(1, 'dlg', 'o1')).toEqual({ chain: CHAIN, booking_mode: 'separate_records' });
});

test('неизвестный option_id → null', () => {
  offers.remember(1, 'dlg', { o1: { chain: CHAIN, booking_mode: 'separate_records' } });
  expect(offers.take(1, 'dlg', 'o2')).toBeNull();
});

test('повторный remember того же диалога перезаписывает предложения (актуален последний вызов)', () => {
  offers.remember(1, 'dlg', { o1: { chain: CHAIN, booking_mode: 'separate_records' } });
  offers.remember(1, 'dlg', { o1: { chain: CHAIN, booking_mode: 'single_record' } });
  expect(offers.take(1, 'dlg', 'o1').booking_mode).toBe('single_record');
});

test('диалоги и салоны изолированы', () => {
  offers.remember(1, 'a', { o1: { chain: CHAIN, booking_mode: 'single_record' } });
  expect(offers.take(1, 'b', 'o1')).toBeNull();
  expect(offers.take(2, 'a', 'o1')).toBeNull();
});

test('TTL: протухшее предложение не возвращается', () => {
  offers.remember(1, 'dlg', { o1: { chain: CHAIN, booking_mode: 'single_record' } }, { nowMs: 1000 });
  expect(offers.take(1, 'dlg', 'o1', { nowMs: 1000 + offers.TTL_MS + 1 })).toBeNull();
});
```

- [ ] **Step 2: Прогнать — модуля нет**

Run: `cd /root/loyalpro/backend && npx jest agent-sequential-offers`
Expected: FAIL — Cannot find module.

- [ ] **Step 3: Реализовать**

Создай `backend/services/agent/sequential-offers.js`:

```js
'use strict';

// ── Кэш вариантов get_sequential_slots для book_chain. ──────────────────────
// Модель больше не переписывает chain руками (источник ошибок booking_mode):
// get_sequential_slots помечает каждый старт option_id и кладёт цепочку сюда,
// book_chain забирает её по option_id и оформляет детерминированно.
// In-memory на один PM2-процесс (тот же компромисс, что дебаунс диспетчера);
// рестарт/TTL → book_chain вернёт option_expired, модель перезапросит слоты.

const TTL_MS = 30 * 60 * 1000;
const MAX_DIALOGS = 500;   // страховка от утечки: старейший диалог вытесняется

const store = new Map();   // `${salonId}:${dialogKey}` → { at, offers }

const keyOf = (salonId, dialogKey) => `${salonId}:${dialogKey}`;

function remember(salonId, dialogKey, offers, opts = {}) {
  const now = opts.nowMs || Date.now();
  const k = keyOf(salonId, dialogKey);
  store.delete(k);   // переставить в конец (Map хранит порядок вставки)
  store.set(k, { at: now, offers: offers || {} });
  while (store.size > MAX_DIALOGS) store.delete(store.keys().next().value);
}

function take(salonId, dialogKey, optionId, opts = {}) {
  const now = opts.nowMs || Date.now();
  const entry = store.get(keyOf(salonId, dialogKey));
  if (!entry || now - entry.at > TTL_MS) return null;
  return entry.offers[optionId] || null;
}

function _reset() { store.clear(); }

module.exports = { remember, take, TTL_MS, _reset };
```

- [ ] **Step 4: Прогнать**

Run: `cd /root/loyalpro/backend && npx jest agent-sequential-offers`
Expected: PASS (5 тестов).

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/sequential-offers.js backend/agent-sequential-offers.test.js
git commit -m "feat(agent): sequential-offers — кэш вариантов стыковки для book_chain"
```

---

### Task 7: `get_sequential_slots` — `option_id` на каждый старт

Каждый старт в выдаче получает `option_id` (`o1`, `o2`, …), цепочка целиком запоминается в `sequential-offers`.

**Files:**
- Modify: `backend/services/agent/tools/get-sequential-slots.js`
- Test: `backend/agent-sequential-slots.test.js`

- [ ] **Step 1: Изучить существующие тесты**

Прочитай `backend/agent-sequential-slots.test.js` — как мокаются `db`/`ycGetStaffSeances`/`listServices`. Новые тесты — в том же стиле.

- [ ] **Step 2: Написать падающие тесты**

```js
test('каждый старт выдачи имеет уникальный option_id формата oN', async () => {
  const res = await run(salonId, { services: [...], date: '2026-07-30' }, ctx);
  const ids = res.variants.flatMap(v => v.starts.map(s => s.option_id));
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^o\d+$/);
});

test('варианты запоминаются в sequential-offers: take по option_id отдаёт chain и booking_mode', async () => {
  const offers = require('./services/agent/sequential-offers');
  offers._reset();
  const res = await run(salonId, { services: [...], date: '2026-07-30' }, { ...ctx, dialogKey: 'dlg' });
  const st = res.variants[0].starts[0];
  const saved = offers.take(salonId, 'dlg', st.option_id);
  expect(saved.chain).toEqual(st.chain);
  expect(saved.booking_mode).toBe(st.booking_mode);
});
```

(Аргументы `services`/моки — скопируй из ближайшего работающего теста этого файла.)

- [ ] **Step 3: Прогнать — убедиться, что падают**

Run: `cd /root/loyalpro/backend && npx jest agent-sequential-slots -t "option_id"`
Expected: FAIL.

- [ ] **Step 4: Реализовать**

В `get-sequential-slots.js`:

```js
const seqOffers = require('../sequential-offers');
```

Перед `const out = { requested_date: date, variants: shortlist, ... };` добавь нумерацию и запоминание:

```js
  // option_id на каждый старт + кэш цепочек: пациент выбирает вариант →
  // модель зовёт book_chain(option_id), НЕ переписывая chain руками.
  let optN = 0;
  const offerMap = {};
  for (const v of shortlist) {
    for (const st of v.starts) {
      st.option_id = `o${++optN}`;
      offerMap[st.option_id] = {
        chain: st.chain,
        booking_mode: st.booking_mode,
        anchored: !!v.anchored,
      };
    }
  }
  if (ctx && ctx.dialogKey) seqOffers.remember(salonId, ctx.dialogKey, offerMap, { nowMs });
```

- [ ] **Step 5: Прогнать весь файл тестов**

Run: `cd /root/loyalpro/backend && npx jest agent-sequential-slots`
Expected: PASS (старые тесты не трогали `option_id` — не должны сломаться).

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/tools/get-sequential-slots.js backend/agent-sequential-slots.test.js
git commit -m "feat(agent): get_sequential_slots помечает старты option_id и кэширует цепочки для book_chain"
```

---

### Task 8: Инструмент `book_chain` — оформление цепочки кодом

Самая рискованная обязанность модели (интерпретация `booking_mode`, `anchored`, порядка create/modify) уходит в код. `book_chain` переиспользует существующие хендлеры `create-booking`/`modify-booking-services` — все их guard'ы (фильтр услуг, проверка id, подстановка телефона, идемпотентность) сохраняются бесплатно.

**Files:**
- Create: `backend/services/agent/tools/book-chain.js`
- Modify: `backend/services/agent/tools/index.js` (регистрация)
- Modify: `backend/services/agent/orchestrator.js` (флаги успеха/провала)
- Test: `backend/agent-tools.test.js` (или новый `backend/agent-book-chain.test.js` — предпочтительно новый)

- [ ] **Step 1: Написать падающие тесты**

Создай `backend/agent-book-chain.test.js`:

```js
'use strict';

const bookChain = require('./services/agent/tools/book-chain');
const offers = require('./services/agent/sequential-offers');

beforeEach(() => offers._reset());

const CTX = { dialogKey: 'dlg', clientPhone: '79990001122', clientName: 'Анна' };
const LINK = (svc, staff, dt) => ({
  service_yc_id: svc, service_title: `svc${svc}`, staff_yc_id: staff,
  datetime: dt, seance_length: 3600,
});

function deps(overrides = {}) {
  return {
    createBooking: jest.fn(async () => ({ created: true, record_id: 555 })),
    modifyServices: jest.fn(async () => ({ modified: true, record_id: 555 })),
    ...overrides,
  };
}

test('option_id не найден/протух → option_expired, ничего не бронируем', async () => {
  const d = deps();
  const res = await bookChain.run(1, { option_id: 'o9', comment: 'к' }, CTX, d);
  expect(res.option_expired).toBe(true);
  expect(d.createBooking).not.toHaveBeenCalled();
});

test('single_record: create по первой услуге + modify с остальными', async () => {
  offers.remember(1, 'dlg', { o1: { booking_mode: 'single_record', chain: [
    LINK(101, 7, '2026-07-30T14:00:00+03:00'), LINK(102, 7, '2026-07-30T15:00:00+03:00'),
  ] } });
  const d = deps();
  const res = await bookChain.run(1, { option_id: 'o1', comment: 'чистка+консультация' }, CTX, d);
  expect(res.booked_all).toBe(true);
  expect(d.createBooking).toHaveBeenCalledTimes(1);
  expect(d.createBooking.mock.calls[0][1]).toMatchObject({
    staff_yc_id: 7, service_yc_id: 101, datetime: '2026-07-30T14:00:00+03:00',
    seance_length: 3600, comment: 'чистка+консультация',
  });
  expect(d.modifyServices).toHaveBeenCalledWith(1,
    { record_id: 555, add_service_yc_ids: [102] }, CTX);
});

test('separate_records: create_booking на каждый элемент chain', async () => {
  offers.remember(1, 'dlg', { o1: { booking_mode: 'separate_records', chain: [
    LINK(101, 7, '2026-07-30T14:00:00+03:00'), LINK(102, 8, '2026-07-30T15:00:00+03:00'),
  ] } });
  const d = deps();
  const res = await bookChain.run(1, { option_id: 'o1', comment: 'к' }, CTX, d);
  expect(res.booked_all).toBe(true);
  expect(res.records).toHaveLength(2);
  expect(d.createBooking).toHaveBeenCalledTimes(2);
  expect(d.modifyServices).not.toHaveBeenCalled();
});

test('anchored: элемент already_booked пропускается, бронируются только последующие', async () => {
  const first = { ...LINK(101, 7, '2026-07-30T14:00:00+03:00'), already_booked: true };
  offers.remember(1, 'dlg', { o1: { booking_mode: 'separate_records', anchored: true,
    chain: [first, LINK(102, 7, '2026-07-30T15:00:00+03:00')] } });
  const d = deps();
  const res = await bookChain.run(1, { option_id: 'o1', comment: 'к' }, CTX, d);
  expect(res.booked_all).toBe(true);
  expect(d.createBooking).toHaveBeenCalledTimes(1);
  expect(d.createBooking.mock.calls[0][1].service_yc_id).toBe(102);
});

test('провал первой записи → booked_all:false, partial:false, ничего дальше не бронируем', async () => {
  offers.remember(1, 'dlg', { o1: { booking_mode: 'separate_records', chain: [
    LINK(101, 7, '2026-07-30T14:00:00+03:00'), LINK(102, 8, '2026-07-30T15:00:00+03:00'),
  ] } });
  const d = deps({ createBooking: jest.fn(async () => ({ created: false, error: 'время недоступно' })) });
  const res = await bookChain.run(1, { option_id: 'o1', comment: 'к' }, CTX, d);
  expect(res.booked_all).toBe(false);
  expect(res.partial).toBe(false);
  expect(d.createBooking).toHaveBeenCalledTimes(1);
});

test('провал ВТОРОЙ записи → partial:true с перечнем созданного и failed_at', async () => {
  offers.remember(1, 'dlg', { o1: { booking_mode: 'separate_records', chain: [
    LINK(101, 7, '2026-07-30T14:00:00+03:00'), LINK(102, 8, '2026-07-30T15:00:00+03:00'),
  ] } });
  let n = 0;
  const d = deps({ createBooking: jest.fn(async () =>
    ++n === 1 ? { created: true, record_id: 555 } : { created: false, error: 'занято' }) });
  const res = await bookChain.run(1, { option_id: 'o1', comment: 'к' }, CTX, d);
  expect(res.booked_all).toBe(false);
  expect(res.partial).toBe(true);
  expect(res.records).toEqual([expect.objectContaining({ record_id: 555 })]);
  expect(res.failed_at).toBe('svc102');
});

test('client_phone/client_name из input пробрасываются в каждую бронь (запись другого человека)', async () => {
  offers.remember(1, 'dlg', { o1: { booking_mode: 'separate_records', chain: [
    LINK(101, 7, '2026-07-30T14:00:00+03:00'), LINK(102, 8, '2026-07-30T15:00:00+03:00'),
  ] } });
  const d = deps();
  await bookChain.run(1, { option_id: 'o1', comment: 'к', client_phone: '79995556677', client_name: 'Мама' }, CTX, d);
  for (const call of d.createBooking.mock.calls) {
    expect(call[1]).toMatchObject({ client_phone: '79995556677', client_name: 'Мама' });
  }
});
```

- [ ] **Step 2: Прогнать — модуля нет**

Run: `cd /root/loyalpro/backend && npx jest agent-book-chain`
Expected: FAIL — Cannot find module.

- [ ] **Step 3: Реализовать `book-chain.js`**

Создай `backend/services/agent/tools/book-chain.js`:

```js
'use strict';

// ── Оформление выбранного варианта get_sequential_slots ОДНИМ вызовом. ──────
// Раньше модель сама интерпретировала booking_mode/anchored и вызывала
// create_booking + modify_booking_services в правильном порядке — самая
// ошибкоопасная многошаговая write-оркестровка промпта. Теперь это код.
// Переиспользуем хендлеры create-booking/modify-booking-services: все их
// guard'ы (фильтр услуг, проверка id, подстановка телефона, идемпотентность)
// работают и здесь.

const createBk = require('./create-booking');
const modifySvc = require('./modify-booking-services');
const offers = require('../sequential-offers');

const schema = {
  name: 'book_chain',
  description: 'ОФОРМИТЬ выбранный пациентом вариант из get_sequential_slots одним вызовом. ' +
    'Передай option_id выбранного старта — инструмент сам создаст все записи цепочки правильным ' +
    'способом (одной записью или отдельными, уже записанную услугу не тронет). Вызывать ТОЛЬКО ' +
    'после явного согласия пациента на конкретный вариант. НЕ оформляй цепочку вручную через ' +
    'create_booking. Если вернул option_expired — вызови get_sequential_slots заново и предложи ' +
    'свежие варианты.',
  input_schema: {
    type: 'object',
    properties: {
      option_id: { type: 'string', description: 'option_id выбранного старта из последнего ответа get_sequential_slots.' },
      comment: { type: 'string', description: 'ОБЯЗАТЕЛЬНО: краткий контекст обращения для администратора (как в create_booking).' },
      client_phone: { type: 'string', description: 'Телефон, если записываем другого человека (иначе не передавай — подставится сам).' },
      client_name: { type: 'string', description: 'Имя пациента, если известно.' },
    },
    required: ['option_id'],
    additionalProperties: false,
  },
};

// deps — для тестов; по умолчанию реальные хендлеры инструментов.
async function run(salonId, input, ctx = {}, deps = {}) {
  const createBooking = deps.createBooking || createBk.run;
  const modifyServices = deps.modifyServices || modifySvc.run;

  const offer = offers.take(salonId, ctx.dialogKey, input && input.option_id);
  if (!offer) {
    return {
      option_expired: true,
      error: 'Этот вариант устарел (option_id не найден). Вызови get_sequential_slots заново ' +
        'и предложи пациенту свежие варианты — время могло измениться.',
    };
  }

  const common = {
    comment: input.comment,
    client_phone: input.client_phone,
    client_name: input.client_name,
  };
  // Якорный режим: первая услуга уже записана — её не создаём и не двигаем.
  const items = (offer.chain || []).filter(l => !l.already_booked);
  if (!items.length) return { error: 'В выбранном варианте нет услуг для оформления.' };

  const bookOne = (l) => createBooking(salonId, {
    staff_yc_id: l.staff_yc_id,
    service_yc_id: l.service_yc_id,
    datetime: l.datetime,
    seance_length: l.seance_length,
    ...common,
  }, ctx);

  const records = [];
  const fail = (failedLink, error) => ({
    booked_all: false,
    partial: records.length > 0,
    records,
    failed_at: failedLink.service_title,
    error,
    hint: records.length
      ? 'Часть записей уже создана (records) — ЧЕСТНО скажи пациенту, что оформлено, а что нет; ' +
        'несостоявшиеся услуги предложи отдельным визитом (get_available_slots) или переведи на администратора.'
      : 'Ничего не оформлено. Вызови get_sequential_slots заново и предложи свежие варианты, ' +
        'либо предложи услуги отдельными визитами.',
  });

  if (offer.booking_mode === 'single_record') {
    // Один мастер, без перерыва: одна запись, услуги добавляются в неё.
    const [first, ...rest] = items;
    const r1 = await bookOne(first);
    if (!r1 || !r1.created) return fail(first, (r1 && r1.error) || 'запись не создана');
    records.push({ record_id: r1.record_id, service_title: first.service_title, datetime: first.datetime });
    if (rest.length) {
      const r2 = await modifyServices(salonId, {
        record_id: r1.record_id,
        add_service_yc_ids: rest.map(l => l.service_yc_id),
      }, ctx);
      if (!r2 || !r2.modified) return fail(rest[0], (r2 && r2.error) || 'услуги не добавились в запись');
      records[0].services_count = r2.services_count;
    }
    return { booked_all: true, records };
  }

  // separate_records: отдельная запись на каждый шаг (разные мастера или перерыв —
  // схлопывать нельзя, зазор потерялся бы; см. buildVariant в get-sequential-slots).
  for (const l of items) {
    const r = await bookOne(l);
    if (!r || !r.created) return fail(l, (r && r.error) || 'запись не создана');
    records.push({ record_id: r.record_id, service_title: l.service_title, datetime: l.datetime });
  }
  return { booked_all: true, records };
}

module.exports = { schema, run };
```

- [ ] **Step 4: Прогнать тесты book_chain**

Run: `cd /root/loyalpro/backend && npx jest agent-book-chain`
Expected: PASS (7 тестов).

- [ ] **Step 5: Зарегистрировать инструмент**

В `backend/services/agent/tools/index.js`:

```js
const bookChain = require('./book-chain');
```

и добавь `bookChain` в массив `tools` сразу после `createBk`:

```js
const tools = [searchKb, listSvc, listStaff, getSlots, getParSlot, getSeqSlot, getDates, getClient,
  createBk, bookChain, listBookings, visitHistory, cancelBk, reschedBk, modifySvc,
  bonusBal, abonement, escalate];
```

(`catalogMode` собирается из того же массива — попадёт в оба режима автоматически.)

- [ ] **Step 6: Флаги оркестратора**

В `backend/services/agent/orchestrator.js`:

6a. Добавь `'book_chain'` в `SIDE_EFFECT_TOOLS`:

```js
const SIDE_EFFECT_TOOLS = new Set([
  'create_booking', 'book_chain', 'cancel_booking', 'reschedule_booking', 'modify_booking_services',
  'escalate_to_operator',
]);
```

6b. В цикле обработки tool-результатов, СРАЗУ после строки `if (tc.name === 'create_booking') { ... }` добавь:

```js
        if (tc.name === 'book_chain') {
          // Частичный успех (partial) = записи уже есть → право на «записала»
          // сохраняется (writeSucceeded) и ход нельзя выбрасывать перегенерацией
          // (sideEffect), но серия считается проваленной (bookingErrored) —
          // диспетчер решит про перевод. option_expired — ни успех, ни провал
          // записи: модель перезапросит слоты.
          if (result && (result.booked_all || result.partial)) sideEffect = true;
          if (result && result.booked_all) {
            bookingSucceeded = true; writeSucceeded = true;
            const first = (result.records || [])[0] || {};
            lastWrite = { tool: 'create_booking', input: { datetime: first.datetime, client_name: (tc.input || {}).client_name } };
          } else if (result && (result.partial || result.failed_at)) {
            bookingErrored = true;
            if (result.partial) writeSucceeded = true;
          } else if (result && !result.option_expired) {
            bookingErrored = true;
          }
        }
```

**Внимание:** `book_chain` при провале возвращает `error` в результате → генерический `if (!isError && WRITE_TOOLS.has(...))` его не зачтёт; в `WRITE_TOOLS` `book_chain` НЕ добавляем — весь учёт в блоке выше. Успешный `book_chain` (без `error`) не входит в `WRITE_TOOLS`, поэтому `writeSucceeded`/`lastWrite` выставляются явно в 6b.

- [ ] **Step 7: Тест оркестратора на book_chain**

Добавь в `backend/agent-orchestrator.test.js` (в стиле соседних):

```js
test('book_chain booked_all → writeSucceeded: реплика «записала» не считается ложным успехом', async () => {
  // provider: 1-й ответ — toolCall book_chain; handler возвращает { booked_all:true, records:[...] };
  // 2-й ответ — текст «Записала вас на обе процедуры, ждём!»
  const res = await runDialogWithMocks(/* ... */);
  expect(res.falseSuccess).toBe(false);
  expect(res.bookingFailed).toBe(false);
});

test('book_chain провал без partial → bookingFailed', async () => {
  // handler book_chain → { booked_all:false, partial:false, failed_at:'svc101', error:'занято', records:[] }
  const res = await runDialogWithMocks(/* ... */);
  expect(res.bookingFailed).toBe(true);
});
```

- [ ] **Step 8: Прогнать всё затронутое**

Run: `cd /root/loyalpro/backend && npx jest agent-book-chain agent-orchestrator agent-tools agent-false-success`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/tools/book-chain.js backend/services/agent/tools/index.js backend/services/agent/orchestrator.js backend/agent-book-chain.test.js backend/agent-orchestrator.test.js
git commit -m "feat(agent): book_chain — оформление цепочки стыкованных услуг кодом вместо LLM-оркестровки"
```

---

### Task 9: Промпт — стыковка через `book_chain`

Абзац Сценария 2 про `booking_mode`/`chain`/якорный режим (самый сложный в промпте) сжимается до «выбрал вариант → book_chain(option_id)». Хинты `get_sequential_slots` синхронизируются.

**Files:**
- Modify: `backend/services/agent/system-prompt.js`
- Modify: `backend/services/agent/tools/get-sequential-slots.js` (тексты `hint`)
- Test: `backend/agent-system-prompt.test.js`, `backend/agent-sequential-slots.test.js`

- [ ] **Step 1: Заменить абзац оформления цепочки в промпте**

В `system-prompt.js` найди строку, начинающуюся с:

```
`- Пациент выбрал вариант → оформляй строго по его chain, СЛЕДУЯ полю booking_mode выбранного старта. ...`
```

(строка ~209, заканчивается `...предлагай ТОЛЬКО если пациент сам просит перенести уже записанную процедуру.`) и замени ЦЕЛИКОМ на:

```js
    `- Пациент выбрал вариант → вызови book_chain с option_id этого старта (плюс comment; если записываешь другого человека — его client_phone и client_name). Инструмент САМ оформит все записи цепочки правильным способом — НЕ оформляй её вручную через create_booking и НЕ переноси уже записанную процедуру (в якорном режиме book_chain её не тронет). Перенос записанной процедуры через reschedule_booking (Сценарий 3) предлагай ТОЛЬКО если пациент сам об этом просит.`,
    `- book_chain вернул option_expired — вариант устарел: вызови get_sequential_slots заново и предложи свежие варианты.`,
    `- book_chain вернул booked_all:false — часть цепочки не оформилась: ЧЕСТНО скажи, что уже записано (records), а что нет (failed_at); несозданное предложи отдельным визитом (get_available_slots) или переведи на администратора. НИКОГДА не говори «всё оформлено», если booked_all не true.`,
```

- [ ] **Step 2: Упростить правило «⛔ ЗАПИСЬ СЧИТАЕТСЯ СОЗДАННОЙ…»**

В той же секции найди строку `⛔ ЗАПИСЬ СЧИТАЕТСЯ СОЗДАННОЙ ТОЛЬКО ПОСЛЕ УСПЕШНОГО create_booking.` и после `create_booking` добавь `/book_chain` (двух местах в строке: «пока НЕ вызвала инструмент create_booking» → «пока НЕ вызвала инструмент create_booking или book_chain и НЕ получила успех (created:true / booked_all:true)»). Точная замена фрагмента:

```
`⛔ ЗАПИСЬ СЧИТАЕТСЯ СОЗДАННОЙ ТОЛЬКО ПОСЛЕ УСПЕШНОГО create_booking (или book_chain для цепочки услуг). НИКОГДА не пиши пациенту «записала», «оформлено», «готово», «вы записаны», «ждём вас», пока НЕ вызвала инструмент и НЕ получила в ответ created:true с record_id (для book_chain — booked_all:true). ...`
```

(остальной хвост строки сохрани дословно).

- [ ] **Step 3: Обновить хинты `get_sequential_slots`**

В `get-sequential-slots.js` в обоих hint-текстах успешной выдачи (обычный и якорный) замени инструкции про ручное оформление:

- в якорном hint строку `'Оформляй ТОЛЬКО последующие услуги chain отдельными записями create_booking (staff_yc_id, service_yc_id, datetime, seance_length — из элемента).'` замени на `'Пациент выбрал вариант — оформляй ОДНИМ вызовом book_chain с option_id этого старта (уже записанную услугу инструмент не тронет).'`
- в обычном hint после `'Время предлагай ТОЛЬКО из starts.'` добавь `' Пациент выбрал вариант — оформляй ОДНИМ вызовом book_chain с option_id этого старта, НЕ через create_booking вручную.'`

Также в `schema.description` инструмента добавь в конец: `' Выбранный пациентом вариант оформляй инструментом book_chain по option_id старта.'`

- [ ] **Step 4: Прогнать и починить тесты промпта**

Run: `cd /root/loyalpro/backend && npx jest agent-system-prompt agent-sequential-slots`
Expected: часть ассертов `agent-system-prompt.test.js` на старый текст (`booking_mode`, `СЛЕДУЯ полю booking_mode`, `modify_booking_services с record_id новой записи`) упадёт. Для каждого упавшего: замени ожидаемую подстроку на соответствующую новую из Step 1–2 (тест должен продолжать проверять, что сценарий стыковки присутствует и ссылается на book_chain/option_id). Добавь новый ассерт:

```js
test('сценарий стыковки предписывает book_chain по option_id, а не ручную оркестровку', () => {
  const p = buildSystemPrompt({});
  expect(p).toContain('book_chain с option_id');
  expect(p).not.toContain('СЛЕДУЯ полю booking_mode');
});
```

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/system-prompt.js backend/services/agent/tools/get-sequential-slots.js backend/agent-system-prompt.test.js backend/agent-sequential-slots.test.js
git commit -m "feat(agent): промпт стыковки через book_chain(option_id) — ручная оркестровка chain/booking_mode убрана из LLM"
```

---

### Task 10: Промпт — режимозависимые правила фактов

В catalog-режиме несколько правил фактически лгут: «цены мастеров есть в поле staff внутри list_services» (в каталоге per-master цен НЕТ), и строка «Прежде чем ответить по существу, вызови search_knowledge_base, list_services…» противоречит и режиму, и правилу экономии вызовов. Делаем `buildSystemPrompt` режимозависимым в этих местах. `CATALOG_SOURCE_RULE` остаётся для остальных упоминаний.

**Files:**
- Modify: `backend/services/agent/system-prompt.js`
- Test: `backend/agent-system-prompt.test.js`

- [ ] **Step 1: Написать падающие тесты**

В `agent-system-prompt.test.js`:

```js
describe('режимозависимые правила фактов (catalog vs legacy)', () => {
  const CATALOG = 'КАТАЛОГ УСЛУГ КЛИНИКИ (тест)\n1|Чистка|60|6500|Уход|7';

  test('catalog-режим: за ценами мастеров отправляет в get_service_masters, а не в поле staff', () => {
    const p = buildSystemPrompt({ catalogBlock: CATALOG });
    expect(p).toContain('get_service_masters');
    expect(p).not.toContain('всё это уже есть в поле staff внутри list_services');
  });

  test('legacy-режим: правило про поле staff сохраняется', () => {
    const p = buildSystemPrompt({});
    expect(p).toContain('поле staff внутри list_services');
  });

  test('строка «Прежде чем ответить по существу, вызови…» удалена в обоих режимах', () => {
    for (const p of [buildSystemPrompt({}), buildSystemPrompt({ catalogBlock: CATALOG })]) {
      expect(p).not.toContain('Прежде чем ответить по существу, вызови');
    }
  });
});
```

- [ ] **Step 2: Прогнать — убедиться, что падают**

Run: `cd /root/loyalpro/backend && npx jest agent-system-prompt -t "режимозависимые"`
Expected: FAIL.

- [ ] **Step 3: Реализовать в `buildSystemPrompt`**

3a. Введи флаг режима в начале функции (после `const catalogBlock = ...`):

```js
  const catalogMode = !!catalogBlock;
```

3b. Удали строку:

```
`Прежде чем ответить по существу, вызови search_knowledge_base, list_services, list_staff, get_available_dates или get_available_slots.`,
```

(правило «факты только из инструментов» выше уже покрывает суть, а перечисление провоцирует лишние вызовы и упоминает несуществующий в catalog-режиме list_services).

3c. Правило экономии `- НЕ вызывай list_staff ради мастеров...` сделай режимозависимым — замени строку на:

```js
    catalogMode
      ? `- НЕ вызывай list_staff ради мастеров или их yc_id: id мастеров каждой услуги есть в каталоге (колонка «id мастеров» + легенда «Мастера»). Персональная цена каждого мастера — ТОЛЬКО через get_service_masters. list_staff нужен ТОЛЬКО чтобы найти специалиста, названного пациентом по имени, когда услуга ещё не выбрана.`
      : `- НЕ вызывай list_staff ради мастеров, их yc_id или цен конкретной услуги: всё это уже есть в поле staff внутри list_services ({yc_id, name, price_min, price_max}). list_staff нужен ТОЛЬКО чтобы найти специалиста, названного пациентом по имени, когда услуга ещё не выбрана.`,
```

3d. Строку `На вопрос «кто делает такую-то услугу / что делает такой-то специалист» — list_services (в каждой услуге поле staff ...)` замени на режимозависимую:

```js
    catalogMode
      ? `На вопрос «кто делает такую-то услугу / что делает такой-то специалист» отвечай по каталогу: колонка «id мастеров» строки услуги + легенда «Мастера» (id=имя). Персональные цены мастеров — get_service_masters.`
      : `На вопрос «кто делает такую-то услугу / что делает такой-то специалист» — list_services (в каждой услуге поле staff — список мастеров, которые её выполняют, с их yc_id и ценой КАЖДОГО мастера: {yc_id, name, price_min, price_max}).`,
```

3e. Строку `ЦЕНА ЗАВИСИТ ОТ МАСТЕРА. Когда спрашивают стоимость — обязательно сверь цены мастеров в поле staff. ...` замени на:

```js
    catalogMode
      ? `ЦЕНА ЗАВИСИТ ОТ МАСТЕРА. Если у услуги в каталоге диапазон «X-Y» — цены мастеров различаются: вызови get_service_masters и назови по мастерам их price_display: «у специалиста Ивановой — 3 000 ₽, у главного врача Петровой — 5 000 ₽». НИКОГДА не выдумывай причину разницы цен (не «мужская/женская», не «аппарат мощнее», не «дольше по времени») — причина только в разных мастерах. Называй факт цены, без домыслов.`
      : `ЦЕНА ЗАВИСИТ ОТ МАСТЕРА. Когда спрашивают стоимость — обязательно сверь цены мастеров в поле staff. Если у всех цена одинаковая — назови одну. Если различается — назови по мастерам: «у специалиста Ивановой — 3 000 ₽, у главного врача Петровой — 5 000 ₽». НИКОГДА не выдумывай причину разницы цен (не «мужская/женская», не «аппарат мощнее», не «дольше по времени») — причина только в разных мастерах. Называй факт цены, без домыслов.`,
```

3f. Из `CATALOG_SOURCE_RULE` убери последнее предложение (про get_service_masters — оно теперь живёт в правилах 3c–3e и дублировалось бы):

```
'Персональной цены каждого мастера в каталоге НЕТ (там общий диапазон услуги): когда пациент спрашивает цену у конкретного мастера или нужна точная сумма, а у услуги диапазон, — вызови get_service_masters со списком yc_id услуг, он вернёт цену каждого мастера.'
```

→ удалить (запятую/пробел перед ним поправить).

- [ ] **Step 4: Прогнать и починить старые ассерты**

Run: `cd /root/loyalpro/backend && npx jest agent-system-prompt`
Expected: новые тесты PASS; старые ассерты на удалённую строку «Прежде чем ответить…» или на старый текст `CATALOG_SOURCE_RULE` — обнови по фактическим новым строкам (смысл: catalog-режим не должен ссылаться на несуществующие данные).

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js
git commit -m "fix(agent): режимозависимые правила фактов — в catalog-режиме промпт не ссылается на per-master цены в list_services"
```

---

### Task 11: Промпт — консолидация ценовых правил

После Task 1 каталог сам показывает точную цену/диапазон/«инд.» — объяснение семантики `price_min/price_max` в промпте больше не нужно. Пять разрозненных ценовых блоков сжимаются в один раздел «ЦЕНЫ». Формулировки, выверенные живыми тестами (диапазон направления, «препарат подбирает врач»), переносятся дословно.

**Files:**
- Modify: `backend/services/agent/system-prompt.js`
- Test: `backend/agent-system-prompt.test.js`

- [ ] **Step 1: Собрать единый блок «ЦЕНЫ»**

В `system-prompt.js` найди и УДАЛИ следующие строки (они переезжают в блок ниже):
- `ЦЕНУ НАЗЫВАЙ ТОЛЬКО НА ПРЯМОЙ ВОПРОС О СТОИМОСТИ...`
- `ЦЕНА КОНКРЕТНОЙ УСЛУГИ — НАЗЫВАЙ ТОЧНО, БЕЗ СЛОВА «ОТ»...` (вся длинная строка с price_min/price_max)
- Строки блока `ЦЕНА НА НАПРАВЛЕНИЕ, А НЕ НА КОНКРЕТНУЮ УСЛУГУ...` (заголовок + 5 подпунктов `-`)
- Третий подпункт правила «ПРЕПАРАТ/ФИЛЛЕР НЕ УТОЧНЯЕМ» (`- ЦЕНА этих трёх обобщённых услуг в каталоге — служебная заглушка (например 1 ₽)...`) — заменяется ссылкой на «инд.» в новом блоке; вместо него вставь короткую строку:

```js
    `- Цена этих трёх обобщённых услуг в каталоге помечена «инд.» — действуй по разделу «ЦЕНЫ» (диапазон направления, точная цена — когда выбран конкретный препарат).`,
```

На место строки «ЦЕНУ НАЗЫВАЙ ТОЛЬКО НА ПРЯМОЙ ВОПРОС…» вставь единый блок:

```js
    `ЦЕНЫ (ЕДИНЫЕ ПРАВИЛА):`,
    `- Цену называй ТОЛЬКО на прямой вопрос о стоимости («сколько стоит», «какая цена», «почём»). Если пациент спрашивает о наличии процедуры, её сути или о записи, но цену НЕ спрашивал — цену по своей инициативе НЕ добавляй.`,
    `- Цена КОНКРЕТНОЙ услуги — дословно из каталога: одно число называй точно («6 500 ₽»), БЕЗ слова «от»; диапазон «X-Y» — это разные цены у мастеров (см. правило «ЦЕНА ЗАВИСИТ ОТ МАСТЕРА»); «инд.» — цифру НЕ называй: стоимость определит врач, отвечай диапазоном направления (пункт ниже).`,
    `- Цена НАПРАВЛЕНИЯ (пациент спрашивает стоимость целого направления: «сколько стоит биоревитализация?», «какие цены на эпиляцию?»): НИКОГДА не перечисляй все услуги/препараты/зоны с ценами — по услугам направления (отобранным через category_path) назови ДИАПАЗОН «от {минимальная} до {максимальная} ₽»; услуги с ценой «инд.» в подсчёт диапазона не включай. Если верхней границы нет — просто «от {минимальная} ₽». Слово «от» уместно ТОЛЬКО здесь, где конкретная услуга ещё не выбрана.`,
    `- Инъекционные направления, где выбор — это препарат (биоревитализация, мезотерапия, ботулинотерапия и т.п.): после диапазона добавь, что препарат подбирается индивидуально по показаниям на очной консультации с врачом. Препараты перечисляй ТОЛЬКО если пациент прямо спросил, на каких препаратах делается процедура. Цену конкретного препарата называй ТОЛЬКО если спросили цену именно этого препарата.`,
    `- Направления, где выбор — это зона (лазерная эпиляция и т.п.): после диапазона скажи, что представлено много зон и есть выгодные комплексы, и уточни, какая зона или зоны интересуют. Цены называй только на конкретные зоны, которые назвал пациент.`,
    `- Если пациент СРАЗУ спросил цену КОНКРЕТНОЙ услуги, зоны или препарата — назови её стоимость сразу, без диапазона и встречных уточнений.`,
```

- [ ] **Step 2: Прогнать и починить тесты**

Run: `cd /root/loyalpro/backend && npx jest agent-system-prompt`
Expected: ассерты на удалённые формулировки упадут. Для каждого: если проверяемый инвариант сохранился в новом блоке (например «препарат подбирается индивидуально», «НИКОГДА не перечисляй все услуги»), поменяй ожидаемую подстроку на новую; если ассерт проверял именно семантику price_min/price_max — замени на проверку новой строки «дословно из каталога: одно число называй точно». Добавь тест:

```js
test('ценовые правила консолидированы в один блок и не дублируются', () => {
  const p = buildSystemPrompt({});
  expect(p).toContain('ЦЕНЫ (ЕДИНЫЕ ПРАВИЛА):');
  expect(p).not.toContain('price_max почти всегда не заполнен');
  // «от» без верхней границы разрешено ровно в одном месте — диапазон направления
  expect(p.match(/Слово «от» уместно ТОЛЬКО/g)).toHaveLength(1);
});
```

- [ ] **Step 3: Смоук всех агентских тестов**

Run: `cd /root/loyalpro/backend && npx jest agent-`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js
git commit -m "refactor(agent): ценовые правила промпта консолидированы в блок «ЦЕНЫ» — семантика price_min/price_max ушла в код каталога"
```

---

### Task 12: Промпт — готовые шаблоны первого сообщения по identity-случаям

Сейчас образец приветствия («…на какую процедуру вы хотели бы записаться?») конфликтует с identity-блоком нового пациента («уточни, как к вам обращаться») — модель вынуждена сама сливать два вопроса, нарушая «один вопрос на сообщение». Даём готовый шаблон на каждый случай.

**Files:**
- Modify: `backend/services/agent/system-prompt.js`
- Test: `backend/agent-system-prompt.test.js`

- [ ] **Step 1: Написать падающие тесты**

```js
describe('шаблоны первого сообщения по identity-случаям', () => {
  test('известный пациент: образец с обращением по имени, БЕЗ вопроса об имени', () => {
    const p = buildSystemPrompt({ clientName: 'Анна' });
    expect(p).toContain('Здравствуйте, Анна!');
    expect(p).not.toContain('как могу к вам обращаться');
  });
  test('новый пациент с известным номером: образец объединяет имя и цель одним сообщением', () => {
    const p = buildSystemPrompt({ phoneKnown: true });
    expect(p).toContain('как могу к вам обращаться');
  });
  test('канал без номера: образец тоже спрашивает имя', () => {
    const p = buildSystemPrompt({});
    expect(p).toContain('как могу к вам обращаться');
  });
});
```

- [ ] **Step 2: Прогнать — первый тест упадёт**

Run: `cd /root/loyalpro/backend && npx jest agent-system-prompt -t "шаблоны первого"`
Expected: FAIL (образец «Здравствуйте, Анна!» не существует).

- [ ] **Step 3: Реализовать**

3a. В правиле тона про первое сообщение (строка с `В ПЕРВОМ сообщении диалога (приветствие) представься по имени...`) замени фрагмент с образцом:

```
`- В ПЕРВОМ сообщении диалога (приветствие) представься по имени и укажи, что ты виртуальный администратор, затем сразу переходи к делу — точный образец первого сообщения смотри в блоке «ИДЕНТИФИКАЦИЯ ПАЦИЕНТА» в конце промпта. Дальше по имени больше не представляйся.`,
```

3b. В каждый из трёх вариантов `identityBlock` добавь образец первым пунктом:

Для известного пациента (`clientName`):

```js
    `- Образец ПЕРВОГО сообщения: «Здравствуйте, ${clientName}! 👋 Я Мила, виртуальный администратор ${salonName}. Подскажите, чем могу помочь?»`,
```

Для `phoneKnown` (новый пациент):

```js
    `- Образец ПЕРВОГО сообщения (приветствие, имя и цель — ОДНИМ сообщением, больше вопросов не задавай): «Здравствуйте! 👋 Я Мила, виртуальный администратор ${salonName}. Подскажите, как могу к вам обращаться и на какую процедуру хотели бы записаться? 🌸»`,
```

Для канала без номера — тот же образец, что и для `phoneKnown` (вставь ту же строку в третий вариант).

**Внимание:** `identityBlock` — волатильная часть в самом низу промпта; образцы с `${clientName}` там и должны жить (не поднимать в кэшируемый префикс).

- [ ] **Step 4: Прогнать**

Run: `cd /root/loyalpro/backend && npx jest agent-system-prompt`
Expected: PASS; ассерты на старый образец «С удовольствием помогу вам с записью! Подскажите, на какую процедуру» обнови на новую формулировку из 3a/3b.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js
git commit -m "fix(agent): готовые шаблоны первого сообщения на каждый identity-случай — конфликт «имя vs процедура» устранён"
```

---

### Task 13: Финальная проверка

- [ ] **Step 1: Полный прогон агентских тестов**

Run: `cd /root/loyalpro/backend && npx jest agent- chat get-available-slots --silent`
Expected: PASS все сьюты (до правок было 357 агентских тестов; после — больше). Любой FAIL — чинить до продолжения.

- [ ] **Step 2: Рестарт дев-сервера**

```bash
pm2 restart loyalpro && sleep 3 && pm2 logs loyalpro --lines 20 --nostream
```

Expected: сервер поднялся без ошибок в логе (дев требует рестарта, чтобы подхватить правки агента).

- [ ] **Step 3: Живой E2E на тестовом номере**

Использовать скилл `clear-history` (тестовый номер 79200255591), затем через тест-харнесс/MAX прогнать сценарии и смотреть `pm2 logs loyalpro`:

1. «Сколько стоит комбинированная чистка лица?» → точная цена без «от», без слова «прайс/каталог» в ответе.
2. «Сколько стоит биоревитализация?» → диапазон направления, «1 ₽» нигде не всплывает.
3. «Хочу чистку и консультацию врача в один день» → варианты из get_sequential_slots; выбрать вариант → в логах виден вызов `book_chain`, записи создаются; подтверждение честное.
4. «Я опаздываю» → благодарность + фраза про администратора уходит ВСЕГДА (проверить лог диспетчера).
5. В логах поискать `reply-guard:` — оценить шум `unknown_time` (ожидание: только реальные нарушения; если ложные срабатывания на длительностях/датах — задокументировать для тюнинга регэкспа, но НЕ включать enforcement).

- [ ] **Step 4: Финальный коммит документации (если менялись хинты/поведение, зафиксировать в CLAUDE.md раздел «AI-агент»)**

Дописать в CLAUDE.md (раздел «AI-агент: управление и гейт допуска») одну строку:

```
- `book_chain` (tools/book-chain.js) оформляет выбранный вариант get_sequential_slots по option_id (кэш sequential-offers.js, TTL 30 мин, in-memory на процесс); reply-guard.js линтует финальную реплику (лог + одно переписывание при утечке внутренней кухни).
```

```bash
cd /root/loyalpro && git add CLAUDE.md
git commit -m "docs: book_chain и reply-guard в описании агента"
```

---

## Что осознанно НЕ делаем (YAGNI)

- **Enforcement `unknown_time`** (регенерация при времени не из слотов) — сначала неделя телеметрии в логах, иначе рискуем глушить честные ответы (времена из истории, длительности).
- **Полное устранение `CATALOG_SOURCE_RULE`** — русская грамматика не позволяет механическую подстановку «каталог услуг» во все падежи; правим только фактически лживые правила (Task 10). Полный перевод правил на шаблоны — отдельная работа после стабилизации.
- **`book_parallel` для записи двоих** — та же идея, что book_chain, но у параллельной записи нет кэшируемых вариантов с booking_mode (просто два create_booking с одинаковым временем — модель с этим справляется, инцидентов не было). Добавить, если появятся ошибки.
- **Персистентный кэш offers в БД** — один PM2-процесс, паттерн in-memory уже принят в диспетчере; `option_expired` — дешёвое восстановление.
