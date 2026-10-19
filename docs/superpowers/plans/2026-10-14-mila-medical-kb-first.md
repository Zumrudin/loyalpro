# Мила: медицинские вопросы сначала по базе знаний — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** на медицинский вопрос пациента статью базы знаний находит КОД до ответа модели и кладёт её в хвост промпта; опасные признаки после процедуры переводят диалог на администратора кодом, без модели; раздел промпта «МЕДИЦИНСКИЕ ГРАНИЦЫ» переписан под решения владельца от 13.10.2026.

**Architecture:** новый чистый модуль `services/agent/medical-kb.js` (детекторы, сбор запроса, отбор фрагментов, текст перевода) + `agent-rag.listArticleTitles` (заголовки статей с TTL-кэшем). Оркестратор: ветка «опасный признак» рядом с оценкой визита (тот же приём, что у низкой оценки) и предвызов КБ рядом со справкой об услуге (тот же приём: ключ по запросу, журнал, кэш повторов, источник address-guard). Промпт получает блок «СВЕДЕНИЯ ИЗ БАЗЫ ЗНАНИЙ ПО ВОПРОСУ ПАЦИЕНТА» в хвосте и переписанный раздел правил. Reply-guard — мягкая телеметрия `medical_kb_unused`.

**Tech Stack:** Node.js 20, Jest (`backend/jest.config.js`, TZ=Europe/Moscow), PostgreSQL через `db` из `backend/db.js`.

**Спека:** `docs/superpowers/specs/2026-10-13-mila-medical-kb-first-design.md`. Все пути ниже — от `backend/` рабочей копии `/root/loyalpro/.worktrees/mila-medical-kb`, ветка `feat/mila-medical-kb-first`. Команды запускать из `/root/loyalpro/.worktrees/mila-medical-kb/backend`.

**Мораторий на промпт-правила (CLAUDE.md):** новых правил НЕ добавляем. Правятся существующие: правило 1, правило 3 и раздел «МЕДИЦИНСКИЕ ГРАНИЦЫ» целиком; блок «СВЕДЕНИЯ…» — это данные с инструкцией к ним (как «СПРАВКА ОБ УСЛУГЕ»), не новое правило поведения. В сообщениях коммитов это сказать явно.

---

## Карта файлов

| Файл | Что | Задача |
|---|---|---|
| `services/agent/service-fact.js` | `stems` экспортируется с параметром `extraStops`; латинские алиасы | 1 |
| `agent-service-fact.test.js` | алиасы не ломают справку | 1 |
| `services/agent/__fixtures__/kb-medical-chunks.js` (новый) | реальные чанки прод-КБ #5, #11, #16, #19 (сокращены) + сборщик выдачи | 2 |
| `services/agent/medical-kb.js` (новый) | `detectRedFlag`, `wantsMedicalKb`, `matchTitles`, `buildMedicalQuery`, `pickMedicalFragments`, `buildRedFlagReply` | 3–6 |
| `agent-medical-kb.test.js` (новый) | тесты модуля | 3–6 |
| `services/agent-rag.js` | `listArticleTitles` + TTL-кэш | 7 |
| `agent-rag-io.test.js` | тесты заголовков | 7 |
| `config.js` | `AGENT_MEDICAL_KB_PREFETCH`, `AGENT_MEDICAL_RED_FLAGS` | 8 |
| `services/agent/system-prompt.js` | правила 1/3, раздел «МЕДИЦИНСКИЕ ГРАНИЦЫ», блок «СВЕДЕНИЯ…» | 9–10 |
| `agent-system-prompt.test.js` | старые тесты раздела заменяются, новые на блок | 9–10 |
| `services/agent/reply-guard.js` | `checkMedicalKbUsage` | 11 |
| `agent-reply-guard.test.js` | `medical_kb_unused` | 11 |
| `services/agent/orchestrator.js` | ветка опасного признака; предвызов; обвязка; lint | 12–13 |
| `agent-orchestrator.test.js` | сьюты «опасный признак» и «медицинский предвызов» | 12–13 |
| `scripts/agent-medical-kb-probe.js` (новый) | живой пробник (платный LLM, прод-КБ read-only) | 14 |
| `CLAUDE.md`, `docs/kb-medical-content-checklist.md` | документация | 16 |

Граф зависимостей модулей (циклов быть не должно): `reply-guard` → `prompt-scenarios`; `service-fact` → `reply-guard`; `medical-kb` → `service-fact`, `reply-guard`, `prompt-scenarios`, `transcript-time`; `system-prompt` → `service-fact`, `reply-guard`. **`reply-guard` не требует ни `service-fact`, ни `medical-kb`** — поэтому у `checkMedicalKbUsage` своя токенизация.

---

### Task 1: `service-fact` — общие стемы и латинские алиасы

**Files:**
- Modify: `services/agent/service-fact.js` (константа `ALIASES`, функция `stems`, `module.exports`)
- Test: `agent-service-fact.test.js`

- [ ] **Step 1: Написать падающие тесты** — дописать в конец `agent-service-fact.test.js`:

```js
describe('общие стемы и латинские алиасы (медицинский предвызов, 2026-10-14)', () => {
  const sf = require('./services/agent/service-fact');

  test('stems экспортируется; extraStops отсекает слова по началу токена', () => {
    expect(sf.stems('терапия губ')).toEqual(expect.arrayContaining(['терап', 'губ']));
    expect(sf.stems('терапия губ', ['терап'])).not.toContain('терап');
    expect(sf.stems('терапия губ', ['терап'])).toContain('губ');
  });

  test.each([
    ['морфеус', 'morpheus'], ['люмекка', 'lumecca'], ['люмека', 'lumecca'],
    ['волньюмер', 'volnewmer'], ['пладуо', 'pladuo'], ['профейшл', 'profacial'],
    ['профешл', 'profacial'], ['хелео', 'heleo'], ['тесла', 'tesla'],
    ['бьютилайзер', 'beautylizer'], ['стилаж', 'stylage'], ['белотеро', 'belotero'],
  ])('«%s» → стем «%s»', (word, stem) => {
    expect(sf.stems(`Сколько стоит ${word}?`)).toContain(stem);
  });

  test('справка находится по кириллическому названию латинского аппарата', () => {
    const ctx = 'STYLAGE M Lidocaine — филлер на гиалуроновой кислоте\n'
      + 'Филлер средней плотности для коррекции носогубных складок и восполнения объёма.';
    const fact = sf.pickServiceFact(ctx, 'Сколько стоит стилаж?');
    expect(fact).toEqual({ title: 'STYLAGE M Lidocaine — филлер на гиалуроновой кислоте',
      text: 'Филлер средней плотности для коррекции носогубных складок и восполнения объёма.' });
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx jest agent-service-fact`
Expected: FAIL — `sf.stems is not a function`.

- [ ] **Step 3: Реализация** — в `services/agent/service-fact.js`:

`ALIASES` дополнить (после строки `'плазм': 'плазм', 'чистк': 'чист', 'пилинг': 'пилинг',`):

```js
  // Латинские названия аппаратов и брендов: в заголовках статей они латиницей,
  // пациент пишет кириллицей. Ключ — начало токена («люмек» ловит и «люмекка»,
  // и частое «люмека»).
  'морфеус': 'morpheus', 'люмек': 'lumecca', 'волнью': 'volnewmer', 'пладуо': 'pladuo',
  'профейш': 'profacial', 'профешл': 'profacial', 'хелео': 'heleo', 'тесла': 'tesla',
  'бьютилайз': 'beautylizer', 'стилаж': 'stylage', 'белотеро': 'belotero',
```

`stems` заменить на:

```js
// extraStops — стоп-префиксы вызывающего (medical-kb добавляет свои: «терапия»
// в вопросе иначе притянула бы все «…терапии» из заголовков).
function stems(userText, extraStops = []) {
  const out = new Set();
  for (const t of tokens(userText)) {
    if (STOP_PREFIXES.some(p => t.startsWith(p)) || extraStops.some(p => t.startsWith(p))) continue;
    out.add(t.slice(0, Math.min(t.length, STEM_LEN + 1)));
    for (const [alias, stem] of Object.entries(ALIASES)) {
      if (t.startsWith(alias)) out.add(stem);
    }
  }
  return [...out];
}
```

В `module.exports` добавить `stems, norm`.

- [ ] **Step 4: Запустить — проходит, и старые тесты справки тоже**

Run: `npx jest agent-service-fact agent-price-followthrough agent-followup-worker`
Expected: PASS все.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/service-fact.js backend/agent-service-fact.test.js
git commit -m "feat(agent): service-fact — общие стемы и латинские алиасы аппаратов

Нужны медицинскому предвызову КБ: стемы общие со справкой об услуге,
латинские заголовки статей (Lumecca, Morpheus, Stylage…) находятся по
кириллическому названию.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Фикстура — реальные чанки прод-КБ

**Files:**
- Create: `services/agent/__fixtures__/kb-medical-chunks.js`

Тексты сняты из прод-БД `loyalpro` read-only 14.10.2026 (`kb_chunks`, salon 1), сокращены. Цены оставлены намеренно — отбор их должен выбросить.

- [ ] **Step 1: Создать файл**

```js
'use strict';
// РЕАЛЬНЫЕ чанки ПРОД-КБ (kb_chunks, salon_id=1, снято read-only 14.10.2026),
// сокращены. Для agent-medical-kb.test.js и сьюта медицинского предвызова в
// agent-orchestrator.test.js. Дев-КБ отстаёт от прода (29 статей против 40,
// #16 короче) — поэтому фикстуры с прода. Первая строка чанка — заголовок
// статьи (chunkArticle в agent-rag.js префиксит его к каждому чанку).
// Статьи: 16 (биоревитализация), 5 (Lumecca), 19 (контурная пластика/губы),
// 11 (лазерная эпиляция).
const MED = {
  bio0: [
    'Биоревитализация и Мезотерапия',
    '# Биоревитализация и Мезотерапия',
    '',
    'Инъекционное введение препаратов на основе гиалуроновой кислоты и коктейлей для глубокого увлажнения, восстановления структуры кожи и решения локальных эстетических задач.',
    '',
    '## Процедуры',
    '',
    '* Сеанс длится **40–60 минут**',
    '* Кожу очищают, наносят крем-анестетик',
    '* Врач вводит препарат микроинъекциями',
    '* Рекомендуется курс из **3–5 процедур** с интервалом в 2–4 недели (для мезотерапии — **5–10 сеансов** раз в 7–14 дней)',
    '',
    '## Подготовка к процедуре',
    '',
    '* За **2–3 дня** исключить алкоголь и кроверазжижающие препараты для минимизации синяков',
  ].join('\n'),
  bio1: [
    'Биоревитализация и Мезотерапия',
    '* Сухость, снижение тонуса',
    '* Мелкие морщины',
    '',
    '## Противопоказания',
    '',
    '* Беременность и лактация',
    '* Онкология',
    '* Аутоиммунные заболевания в стадии обострения',
    '* Воспаления в зоне инъекций',
    '',
    '## Стоимость и препараты',
    '',
    '* **REVI EYE** — 15 500 ₽ (врач) / 18 500 ₽ (гл. врач) · 30 мин',
    '* **REVI STYLE 1 ml** — 16 500 ₽ (врач) / 19 500 ₽ (гл. врач) · 1 ч',
  ].join('\n'),
  lumecca: [
    'LUMECCA — IPL фотоомоложение (InMode)',
    '* Беременность и лактация',
    '* Декомпенсированный сахарный диабет',
    '',
    '## Ощущения во время процедуры',
    '',
    'Яркие вспышки света, ощущение горячего «щелчка» или покалывания. Переносится комфортно за счёт охлаждения насадки.',
    '',
    '## Возможные осложнения',
    '',
    '* Эритема и отёк — 1–3 дня',
    '* Потемнение пигмента («эффект грязной кожи») — 7–14 дней',
    '* Гематомы',
    '',
    '## Рекомендации после процедуры',
    '',
    '* Исключить сауны, бани, бассейны, горячие ванны на 7–10 дней',
  ].join('\n'),
  lips: [
    'Контурная пластика и увеличение губ',
    '### Что делать при бугорке, асимметрии или необычном отёке после филлера?',
    'Мила не назначает мази, массаж или лекарства. Она выражает сочувствие и немедленно передаёт обращение администратору, чтобы с пациентом связался врач или пригласил на осмотр.',
  ].join('\n'),
  laser: [
    'Лазерная эпиляция — Pacer One Pro (755/808/1064 нм)',
    '# Лазерная эпиляция — Pacer One Pro',
    '',
    '## Описание',
    '',
    'Эпиляция проводится по технологии **SHR** — высокочастотное световое воздействие на фолликул с малой плотностью энергии. Тепло накапливается в волосяной луковице и разрушает её **без боли и ожогов**.',
    '',
    '* Курс — **4–6 процедур** для полного результата',
    'Приём с 10:00 до 21:00.',
  ].join('\n'),
};

// Заголовки опубликованных статей прода (подмножество, порядок по id).
const PROD_TITLES = [
  'LUMECCA — IPL фотоомоложение (InMode)',
  'Morpheus 8 — RF-лифтинг с микроиглами (InMode)',
  'Лазерная эпиляция — Pacer One Pro (755/808/1064 нм)',
  'Биоревитализация и Мезотерапия',
  'Коллагенотерапия',
  'Контурная пластика и увеличение губ',
  'Ботулинотерапия',
  'Плазмолифтинг / Плазмотерапия',
  'Консультации и диагностика',
  'Информация о клинике',
  'STYLAGE Special Lips Lidocaine — филлер для губ',
  'Гатауллина Юлия Равильевна — косметолог: опыт, уход за кожей и процедуры для тела',
];

// Выдача search_knowledge_base в форме buildKnowledgeContext (agent-rag.js):
// чанки через пустую строку, fragments — границы каждого, хвост цен каталога.
function medicalSearchResult(keys, { servicesTail = false } = {}) {
  let context = '';
  const fragments = keys.map((k) => {
    const content = MED[k];
    const start = context.length;
    context += `${content}\n\n`;
    return { article_id: { bio0: 16, bio1: 16, lumecca: 5, lips: 19, laser: 11 }[k], start, end: start + content.length };
  });
  if (servicesTail) context += 'АКТУАЛЬНЫЕ УСЛУГИ И ЦЕНЫ:\n- Биоревитализация: 16500 ₽, 60 мин\n';
  return { found: true, context: context.trimEnd(), fragments,
    sources: [...new Set(fragments.map(f => f.article_id))] };
}

module.exports = { MED, PROD_TITLES, medicalSearchResult };
```

- [ ] **Step 2: Проверить, что модуль грузится**

Run: `node -e "const f=require('./services/agent/__fixtures__/kb-medical-chunks'); const r=f.medicalSearchResult(['bio0','laser']); console.log(r.fragments, r.context.slice(r.fragments[1].start, r.fragments[1].start+20))"`
Expected: два фрагмента, второй начинается с `Лазерная эпиляция`.

- [ ] **Step 3: Commit**

```bash
git add backend/services/agent/__fixtures__/kb-medical-chunks.js
git commit -m "test(agent): фикстура — реальные медицинские чанки прод-КБ

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `medical-kb.detectRedFlag` и текст перевода

**Files:**
- Create: `services/agent/medical-kb.js`
- Create: `agent-medical-kb.test.js`

- [ ] **Step 1: Падающие тесты** — создать `agent-medical-kb.test.js`:

```js
'use strict';
const mk = require('./services/agent/medical-kb');
const { HANDOVER_ANNOUNCED_RE } = require('./services/agent/admin-hours');

describe('detectRedFlag — всегда', () => {
  test.each([
    ['После филлера побелела кожа на губе', 'skin_blanching'],
    ['кожа посинела вокруг укола', 'skin_blanching'],
    ['Кожа какая-то мраморная стала', 'skin_blanching'],
    ['Мне трудно дышать', 'breathing'],
    ['задыхаюсь', 'breathing'],
    ['отекает горло', 'breathing'],
    ['язык опух', 'breathing'],
    ['ухудшилось зрение', 'vision'],
    ['двоится в глазах', 'vision'],
    ['пелена перед глазами', 'vision'],
  ])('«%s» → %s', (text, kind) => {
    expect(mk.detectRedFlag(text)).toEqual({ kind });
  });

  test.each([
    'После Lumecca потемнели пятна',
    'синяк побледнел',
    'После губ синяк',
    'хочу больше объёма губ',
    'Добрый вечер',
  ])('«%s» → нет', (text) => {
    expect(mk.detectRedFlag(text)).toBeNull();
  });

  test('метка времени и не-строка не ломают детектор', () => {
    expect(mk.detectRedFlag('[13.10 22:01] задыхаюсь')).toEqual({ kind: 'breathing' });
    expect(mk.detectRedFlag(null)).toBeNull();
    expect(mk.detectRedFlag(['задыхаюсь'])).toBeNull();
  });
});

describe('detectRedFlag — только при контексте процедуры', () => {
  test.each([
    ['После губ поднялась температура', 'fever'],
    ['сделала ботокс, температура 38,5', 'fever'],
    ['вчера делали биоревитализацию, озноб', 'fever'],
    ['После чистки гноится', 'pus'],
    ['после укола нагноение', 'pus'],
    ['после процедуры резкая боль', 'severe_pain'],
    ['После филлера боль нарастает', 'severe_pain'],
  ])('«%s» → %s', (text, kind) => {
    expect(mk.detectRedFlag(text)).toEqual({ kind });
  });

  test.each([
    'температура 38, можно ли прийти на чистку?',
    'Можно ли после процедуры в баню, там высокие температуры?',
    'гной на подбородке, поможет ли чистка?',
  ])('«%s» → нет', (text) => {
    expect(mk.detectRedFlag(text)).toBeNull();
  });
});

describe('buildRedFlagReply', () => {
  test.each([false, true])('adminOff=%s: объявляет перевод (диспетчер не дошлёт вторую фразу)', (adminOff) => {
    expect(mk.buildRedFlagReply({ adminOff })).toMatch(HANDOVER_ANNOUNCED_RE);
  });
  test('нерабочее время — неотложная помощь 103/112', () => {
    expect(mk.buildRedFlagReply({ adminOff: true })).toMatch(/103 или 112/);
    expect(mk.buildRedFlagReply({ adminOff: false })).not.toMatch(/103/);
  });
});
```

Обрати внимание на кейс «гной на подбородке, поможет ли чистка?»: контекста процедуры нет (нет «после/сделала/укол…») — это вопрос о процедуре, а не осложнение.

- [ ] **Step 2: Запустить — падает**

Run: `npx jest agent-medical-kb`
Expected: FAIL — `Cannot find module './services/agent/medical-kb'`.

- [ ] **Step 3: Реализация** — создать `services/agent/medical-kb.js`:

```js
'use strict';
// ============================================================
// Медицинский вопрос пациента — сначала база знаний (спека
// docs/superpowers/specs/2026-10-13-mila-medical-kb-first-design.md).
// ЧИСТЫЙ модуль: ни БД, ни сети. Поход в RAG и заголовки статей делает
// оркестратор. Тесты: agent-medical-kb.test.js.
//
// ЗАЧЕМ: живой прогон 13.10.2026 — на «есть ли смысл делать био, если после
// второй процедуры прошло больше месяца?» модель 3/3 не вызвала КБ, хотя в
// статье #16 прямой ответ («курс 3–5 процедур с интервалом 2–4 недели»).
// Правило «отвечай только по search_knowledge_base» уже было и не держалось,
// новые правила под мораторием — поэтому базу ищет код.
//
// ГРАНИЦЫ СЛОВ — lookaround по \p{L}, а не \b: тот в JS ASCII-only, и именно
// так «боль» ловилась внутри «больше» (prompt-scenarios, вне рамок задачи).
// Текст нормализуется: нижний регистр, ё→е — регулярки ниже пишутся без «ё».
// ============================================================
const { stripAllStamps } = require('./transcript-time');

function norm(text) {
  return stripAllStamps(String(text)).toLowerCase().replace(/ё/g, 'е');
}

// ── Опасные признаки (черновик; список УТВЕРЖДАЕТ ВРАЧ клиники) ──────────────
// Ложное срабатывание = лишний перевод на администратора, это безопасная
// сторона. Пропуск — главный риск решения владельца №3, отсюда два яруса.
// «Синяк» и «потемнело» сюда НЕ входят: потемнение пигмента после Lumecca —
// норма по статье #5.
const BLANCH_RE = /(?<![\p{L}])(?:побел|побледн|посин|мраморн)/u;
// Клауза про синяк/пигмент/пятно — не о коже: «синяк побледнел» — заживает.
const BLANCH_EXCLUDE_RE = /синяк|гематом|пигмент|пятн/u;
const ALWAYS_FLAGS = [
  ['breathing', /(?:трудно|тяжело|сложно|не\s+могу)\s+дыш|(?<![\p{L}])задыха|(?<![\p{L}])(?:отекает|отекло|отек|опух[\p{L}]*)\s+(?:горл|язык)|(?<![\p{L}])(?:горло|язык)\s+(?:отек|опух)/u],
  ['vision', /(?<![\p{L}])зрени[\p{L}]*\s+(?:\p{L}+\s+)?(?:ухудш|упал|пропал|двоит|размыт|помутн)|(?:ухудшил|упал|пропал|помутнел)[\p{L}]*\s+зрени|двоит[\p{L}]*\s+в\s+глаз|в\s+глазах\s+двоит|(?<![\p{L}])пелен/u],
];
// Контекст процедуры: без него «температура 38, можно ли на чистку?» и «гной
// на подбородке» — вопросы о процедуре, а не осложнения.
const PROCEDURE_CONTEXT_RE = /(?<![\p{L}])(?:после|сделал[\p{L}]*|делал[\p{L}]*|поставил[\p{L}]*|укол[\p{L}]*|вкол[\p{L}]*|колол[\p{L}]*)(?![\p{L}])/u;
const CONTEXT_FLAGS = [
  // Жар, а не «высокие температуры» бани: число 38–40, подъём, озноб.
  ['fever', /(?:поднял|подскочил)[\p{L}]*\s+температур|температур[\p{L}]*\s+(?:поднял[\p{L}]*|подскочил[\p{L}]*|3[89]|40)(?!\d)|(?<!\d)(?:3[89]|40)(?:[.,]\d)?\s*(?:°|градус)|(?<![\p{L}])температурю|(?<![\p{L}])озноб|(?<![\p{L}])жар(?![\p{L}])/u],
  ['pus', /(?<![\p{L}])(?:гно[йеияю]|гноит|гнойн|нагно)/u],
  ['severe_pain', /(?<![\p{L}])(?:резк|нарастающ|нестерпим|невыносим)[\p{L}]*\s+бол|(?<![\p{L}])бол[\p{L}]*\s+(?:нараста|усилива|невыносим|нестерпим)/u],
];

/** @returns {{kind:string}|null} */
function detectRedFlag(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const s = norm(text);
  const blanch = s.split(/[.,;!?\n]/u).some(c => BLANCH_RE.test(c) && !BLANCH_EXCLUDE_RE.test(c));
  if (blanch) return { kind: 'skin_blanching' };
  for (const [kind, re] of ALWAYS_FLAGS) if (re.test(s)) return { kind };
  if (!PROCEDURE_CONTEXT_RE.test(s)) return null;
  for (const [kind, re] of CONTEXT_FLAGS) if (re.test(s)) return { kind };
  return null;
}

// Текст перевода (черновик, утверждает клиника). ОБЯЗАН содержать
// «администратор» (admin-hours.HANDOVER_ANNOUNCED_RE) — иначе диспетчер дошлёт
// вторую фразу перевода. Мила на проде работает ночью, поэтому нерабочий
// вариант — основной.
function buildRedFlagReply(opts = {}) {
  const head = 'Мне очень жаль, что вы с этим столкнулись.';
  return opts.adminOff
    ? `${head} Передаю ваше сообщение администратору клиники — сейчас нерабочее время, он увидит его в начале рабочего дня. Если состояние ухудшается, не ждите — обратитесь за неотложной помощью: 103 или 112.`
    : `${head} Срочно передаю ваше сообщение администратору клиники, чтобы с вами как можно скорее связался врач.`;
}

module.exports = { detectRedFlag, buildRedFlagReply };
```

- [ ] **Step 4: Запустить — проходит**

Run: `npx jest agent-medical-kb`
Expected: PASS. Если кейс падает — править регулярку, а не тест: таблица кейсов — критерии спеки.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/medical-kb.js backend/agent-medical-kb.test.js
git commit -m "feat(agent): medical-kb — опасные признаки после процедуры и текст перевода

Черновик списка признаков — на утверждение врачу. Два яруса: всегда
(кожа побелела, дыхание, зрение) и только с контекстом процедуры
(жар, гной, нарастающая боль).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `medical-kb.wantsMedicalKb`

**Files:**
- Modify: `services/agent/medical-kb.js`
- Test: `agent-medical-kb.test.js`

- [ ] **Step 1: Падающие тесты** — дописать:

```js
describe('wantsMedicalKb', () => {
  test.each([
    'Есть ли вообще смысл делать био, если после второй процедуры прошло больше месяца?',
    'Кормлю грудью, можно мне био?',
    'У меня диабет, можно био?',
    'Как проходит лазерная эпиляция, больно?',
    'После Lumecca покраснение 2 дня, это нормально?',
    'После губ бугорок',
    'какие противопоказания у ботокса',
    'на ГВ можно?',
    'болит место укола',
    'боль после чистки',
    'Сколько стоит био при беременности?',   // сильный маркер — всегда
  ])('«%s» → да', (text) => {
    expect(mk.wantsMedicalKb(text)).toBe(true);
  });

  test.each([
    'хочу больше объёма губ',
    'Можно ли записаться на био в пятницу?',      // слабый маркер + запись
    'Можно ли перенести запись на субботу?',      // слабый маркер + перенос
    'Сколько стоит курс биоревитализации?',       // слабый маркер + цена
    'Здравствуйте!',
    '',
  ])('«%s» → нет', (text) => {
    expect(mk.wantsMedicalKb(text)).toBe(false);
  });

  test('не-строка → false', () => {
    expect(mk.wantsMedicalKb(null)).toBe(false);
    expect(mk.wantsMedicalKb(['болит'])).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `npx jest agent-medical-kb -t wantsMedicalKb`
Expected: FAIL — `mk.wantsMedicalKb is not a function`.

- [ ] **Step 3: Реализация** — в `medical-kb.js` после `buildRedFlagReply`, require вверху:

```js
const { detectPromptScenarios, SCENARIOS, isPriceQuestion } = require('./prompt-scenarios');
```

```js
// ── Нужна ли база: сильные маркеры — всегда, слабые — кроме записи/цены ─────
// Слабые («можно ли», «курс», «как проходит») в сообщении о записи/переносе —
// про время, а на вопросе о цене работает справка об услуге (service-fact).
const STRONG_RE = /(?<![\p{L}])(?:противопоказ|показан|беремен|лактац|кормлю\s+грудью|грудн[\p{L}]*\s+вскармлив|гв(?![\p{L}])|диабет|аллерг|герпес|антибиотик|лекарств|таблетк|отек|опух|покрасн|синяк|гематом|болит|боль(?![\p{L}])|сып[ьи](?![\p{L}])|высып|зуд|жжет|шелуш|бугор|шишк|комоч|асимметр|онемел|реабилит|уход\s+после)/u;
const WEAK_RE = /(?<![\p{L}])(?:можно\s+ли|стоит\s+ли|есть\s+ли\s+(?:вообще\s+)?смысл|курс|интервал|перерыв|сколько\s+(?:нужно\s+)?(?:процедур|сеанс)|как\s+часто|подготов|после\s+процедур|загар|загора|бан[яюи](?![\p{L}])|саун|спорт|алкогол|как\s+проходит|сколько\s+длится|эффект|результат|сколько\s+держит|больно)/u;

function wantsMedicalKb(text) {
  if (typeof text !== 'string') return false;
  const s = norm(text);
  if (!s.trim()) return false;
  if (STRONG_RE.test(s)) return true;
  if (!WEAK_RE.test(s)) return false;
  const sc = detectPromptScenarios(s);
  if (sc.includes(SCENARIOS.BOOKING) || sc.includes(SCENARIOS.MANAGE_BOOKING)) return false;
  return !isPriceQuestion(s);
}
```

В `module.exports` добавить `wantsMedicalKb`.

- [ ] **Step 4: Запустить — проходит**

Run: `npx jest agent-medical-kb`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/medical-kb.js backend/agent-medical-kb.test.js
git commit -m "feat(agent): medical-kb — детектор медицинского вопроса (границы по \\p{L})

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `matchTitles` и `buildMedicalQuery`

**Files:**
- Modify: `services/agent/medical-kb.js`
- Test: `agent-medical-kb.test.js`

- [ ] **Step 1: Падающие тесты** — дописать:

```js
const { PROD_TITLES } = require('./services/agent/__fixtures__/kb-medical-chunks');

describe('matchTitles', () => {
  test.each([
    ['Есть ли вообще смысл делать био, если после второй процедуры прошло больше месяца?', ['Биоревитализация и Мезотерапия']],
    ['Кормлю грудью, можно мне био?', ['Биоревитализация и Мезотерапия']],
    ['После Lumecca покраснение 2 дня', ['LUMECCA — IPL фотоомоложение (InMode)']],
    ['после люмекки красное лицо', ['LUMECCA — IPL фотоомоложение (InMode)']],
    ['Как проходит лазерная эпиляция, больно?', ['Лазерная эпиляция — Pacer One Pro (755/808/1064 нм)']],
    ['После губ бугорок', ['Контурная пластика и увеличение губ', 'STYLAGE Special Lips Lidocaine — филлер для губ']],
  ])('«%s»', (text, expected) => {
    expect(mk.matchTitles(text, PROD_TITLES)).toEqual(expected);
  });

  test('медицинские стоп-слова не притягивают заголовки («терапия», «уход после», «консультация»)', () => {
    expect(mk.matchTitles('какая терапия после консультации и уход после', PROD_TITLES)).toEqual([]);
  });

  test('процедура не названа → []', () => {
    expect(mk.matchTitles('у меня бугорок', PROD_TITLES)).toEqual([]);
  });

  test('битые входы → []', () => {
    expect(mk.matchTitles('био', null)).toEqual([]);
    expect(mk.matchTitles(null, PROD_TITLES)).toEqual([]);
  });
});

describe('buildMedicalQuery', () => {
  const BIO = 'Биоревитализация и Мезотерапия';

  test('процедура в последнем сообщении → запрос = оно (тот же kbQuery, что у справки)', () => {
    const sf = require('./services/agent/service-fact');
    const last = '[13.10 22:01] Кормлю грудью, можно мне   био?';
    expect(mk.buildMedicalQuery([last], PROD_TITLES))
      .toEqual({ query: sf.kbQuery(last), titles: [BIO] });
  });

  test('процедура в предыдущем сообщении → «то + последнее»', () => {
    const r = mk.buildMedicalQuery(['А при диабете можно?', 'Хочу на биоревитализацию'], PROD_TITLES);
    expect(r).toEqual({ query: 'Хочу на биоревитализацию А при диабете можно?', titles: [BIO] });
  });

  test('берётся БЛИЖАЙШЕЕ предыдущее с процедурой, не дальше трёх блоков', () => {
    const r = mk.buildMedicalQuery(['А больно?', 'ок', 'Как проходит лазерная эпиляция?', 'хочу био'], PROD_TITLES);
    expect(r.titles).toEqual(['Лазерная эпиляция — Pacer One Pro (755/808/1064 нм)']);
    expect(mk.buildMedicalQuery(['А больно?', 'ок', 'да', 'хочу био'], PROD_TITLES)).toBeNull();
  });

  test('склейка не длиннее 300 символов, последнее сообщение целиком', () => {
    const last = 'А при диабете можно?';
    const r = mk.buildMedicalQuery([last, `биоревитализация ${'очень '.repeat(80)}`], PROD_TITLES);
    expect(r.query.length).toBeLessThanOrEqual(300);
    expect(r.query.endsWith(last)).toBe(true);
  });

  test('процедуры нигде нет / пусто → null', () => {
    expect(mk.buildMedicalQuery(['у меня бугорок'], PROD_TITLES)).toBeNull();
    expect(mk.buildMedicalQuery([], PROD_TITLES)).toBeNull();
    expect(mk.buildMedicalQuery(['био'], [])).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `npx jest agent-medical-kb -t "matchTitles|buildMedicalQuery"`
Expected: FAIL — `mk.matchTitles is not a function`.

- [ ] **Step 3: Реализация** — в `medical-kb.js`, require вверху:

```js
const serviceFact = require('./service-fact');
```

```js
// ── К каким статьям относится вопрос ─────────────────────────────────────────
// Стемы и бытовые названия — ОБЩИЕ со справкой об услуге (service-fact.stems);
// поверх — медицинские стоп-префиксы: «терапия» в вопросе иначе притянула бы
// все «…терапии» из заголовков, «уход после» — статью-биографию косметолога
// («опыт, уход за кожей…»), «консультация» — «Консультации и диагностика».
const MEDICAL_STOP_PREFIXES = [
  'терап', 'лечен', 'после', 'перед', 'курс', 'интерв', 'эффект', 'резуль', 'врач',
  'уход', 'опыт', 'консул', 'диагн', 'делат', 'сделал', 'прошл', 'больш', 'месяц',
  'недел', 'смысл', 'вообщ', 'втор', 'есть',
];
// Трёхбуквенный стем («без», «или») совпадает с чем попало внутри заголовка;
// «губ» — единственный короткий законный (алиас «губы»/«губ»).
const SHORT_STEMS_OK = new Set(['губ']);

function matchTitles(text, titles) {
  if (typeof text !== 'string' || !Array.isArray(titles) || !titles.length) return [];
  const st = serviceFact.stems(text, MEDICAL_STOP_PREFIXES)
    .filter(s => s.length >= 4 || SHORT_STEMS_OK.has(s));
  if (!st.length) return [];
  return titles.filter(t => typeof t === 'string' && t.trim()
    && st.some(s => serviceFact.norm(t).includes(s)));
}

const MAX_COMBINED_QUERY = 300;

/**
 * @param {string[]} userBlocks тексты пациента от ПОСЛЕДНЕГО к ранним (метки
 *   времени срезаются здесь же — serviceFact.kbQuery)
 * @param {string[]} titles заголовки опубликованных статей салона
 * @returns {{query:string, titles:string[]}|null}
 */
function buildMedicalQuery(userBlocks, titles) {
  const blocks = (Array.isArray(userBlocks) ? userBlocks : []).slice(0, 3)
    .map(b => serviceFact.kbQuery(b)).filter(Boolean);
  if (!blocks.length) return null;
  const last = blocks[0];
  // Запрос из одного сообщения — РОВНО kbQuery, как у справки об услуге:
  // совпавший запрос оркестратор берёт из уже сделанного поиска.
  const own = matchTitles(last, titles);
  if (own.length) return { query: last, titles: own };
  for (const prev of blocks.slice(1)) {
    const t = matchTitles(prev, titles);
    if (!t.length) continue;
    const room = Math.max(0, MAX_COMBINED_QUERY - last.length - 1);
    return { query: `${prev.slice(0, room)} ${last}`.trim().slice(-MAX_COMBINED_QUERY), titles: t };
  }
  return null;
}
```

В `module.exports` добавить `matchTitles, buildMedicalQuery, MEDICAL_STOP_PREFIXES`.

- [ ] **Step 4: Запустить — проходит**

Run: `npx jest agent-medical-kb`
Expected: PASS. Если `matchTitles` ловит лишний заголовок из `PROD_TITLES` — добавить стоп-префикс с комментарием, не ослаблять ожидание.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/medical-kb.js backend/agent-medical-kb.test.js
git commit -m "feat(agent): medical-kb — сопоставление вопроса со статьями и сбор запроса

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `pickMedicalFragments`

**Files:**
- Modify: `services/agent/medical-kb.js`
- Test: `agent-medical-kb.test.js`

- [ ] **Step 1: Падающие тесты** — дописать:

```js
const { medicalSearchResult } = require('./services/agent/__fixtures__/kb-medical-chunks');

describe('pickMedicalFragments', () => {
  const BIO = 'Биоревитализация и Мезотерапия';
  const LASER = 'Лазерная эпиляция — Pacer One Pro (755/808/1064 нм)';

  test('оставляет фрагменты нужной статьи, режет чужую, цены и хвост каталога', () => {
    const kb = medicalSearchResult(['bio0', 'laser', 'bio1'], { servicesTail: true });
    const r = mk.pickMedicalFragments(kb, [BIO]);
    expect(r.titles).toEqual([BIO]);
    expect(r.raw).toBe(kb.context);
    const text = r.lines.join('\n');
    expect(text).toContain('Рекомендуется курс из 3–5 процедур с интервалом в 2–4 недели');
    expect(text).toContain('* Беременность и лактация');
    expect(text).not.toContain('Pacer');           // чужая статья
    expect(text).not.toMatch(/₽|REVI/);           // цены — только из каталога
    expect(text).not.toContain('АКТУАЛЬНЫЕ УСЛУГИ');
    expect(text).not.toContain('**');             // разметка жирного снята
    expect(r.lines[0]).toBe(`«${BIO}»:`);         // заголовок фрагмента — строкой-меткой
    expect(r.lines.filter(l => l === `«${BIO}»:`)).toHaveLength(2);
    expect(r.lines).not.toContain(`# ${BIO}`);    // дубль заголовка markdown снят
  });

  test('строки со временем ЧЧ:ММ выбрасываются (засевали бы allowedTimes)', () => {
    const r = mk.pickMedicalFragments(medicalSearchResult(['laser']), [LASER]);
    expect(r.lines.join('\n')).not.toMatch(/10:00/);
    expect(r.lines.join('\n')).toContain('без боли и ожогов');
  });

  test('кап 6000 символов; строка — не длиннее 400; метка без строк не остаётся', () => {
    const body = Array.from({ length: 400 }, (_, i) => `Описание процедуры подробно, пункт ${i}.`).join('\n');
    const context = `${BIO}\n${body}\n${'х'.repeat(900)}`;
    const r = mk.pickMedicalFragments({ context, fragments: [{ start: 0, end: context.length }] }, [BIO]);
    expect(r.lines.join('\n').length).toBeLessThanOrEqual(6000);
    expect(r.lines.every(l => l.length <= 400)).toBe(true);
    // второй фрагмент, не влезший целиком, не оставляет висячую метку «Заголовок»:
    const two = medicalSearchResult(['bio0']);
    const ctx2 = `${context}\n\n${two.context}`;
    const r2 = mk.pickMedicalFragments({ context: ctx2, fragments: [{ start: 0, end: context.length },
      { start: context.length + 2, end: ctx2.length }] }, [BIO]);
    expect(r2.lines[r2.lines.length - 1]).not.toMatch(/^«.*»:$/);
  });

  test('нет fragments / битые границы / ничего нужного → null', () => {
    const kb = medicalSearchResult(['laser']);
    expect(mk.pickMedicalFragments({ context: kb.context }, [LASER])).toBeNull();
    expect(mk.pickMedicalFragments({ context: kb.context, fragments: [{ start: 5, end: 1 }] }, [LASER])).toBeNull();
    expect(mk.pickMedicalFragments(kb, [BIO])).toBeNull();
    expect(mk.pickMedicalFragments(kb, [])).toBeNull();
    expect(mk.pickMedicalFragments(null, [BIO])).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `npx jest agent-medical-kb -t pickMedicalFragments`
Expected: FAIL — `mk.pickMedicalFragments is not a function`.

- [ ] **Step 3: Реализация** — в `medical-kb.js`, require вверху:

```js
const { PRICE_SUM_RE } = require('./reply-guard');
```

```js
// ── Отбор фрагментов выдачи search_knowledge_base ────────────────────────────
// Режем kb.context по kb.fragments (границы чанков, agent-rag) и оставляем
// фрагменты статей из titles. Хвост «АКТУАЛЬНЫЕ УСЛУГИ И ЦЕНЫ» в fragments не
// входит по построению. Строки с суммами — вон (цены только из каталога),
// со временем ЧЧ:ММ — вон (блок стоит после «ТЕКУЩИЙ КОНТЕКСТ:» и засевал бы
// allowedTimes reply-guard). Каждому фрагменту — строка-метка «Заголовок»:
// в блоке бывает несколько статей.
const MAX_MEDICAL_CHARS = 6000;
const MAX_LINE_CHARS = 400;   // тот же кап, что у sanitizeLine в промпте

function isValidFragment(f, len) {
  return f && Number.isInteger(f.start) && Number.isInteger(f.end)
    && f.start >= 0 && f.end > f.start && f.end <= len;
}

/** @returns {{titles:string[], lines:string[], raw:string}|null} */
function pickMedicalFragments(kb, titles) {
  if (!kb || typeof kb.context !== 'string' || !Array.isArray(kb.fragments)) return null;
  const want = new Set((Array.isArray(titles) ? titles : []).map(t => String(t).trim()).filter(Boolean));
  if (!want.size) return null;
  const lines = [];
  const used = [];
  let size = 0;
  for (const f of kb.fragments) {
    if (!isValidFragment(f, kb.context.length)) continue;
    const rows = kb.context.slice(f.start, f.end).split('\n').map(l => l.trim());
    const ti = rows.findIndex(Boolean);
    if (ti < 0 || !want.has(rows[ti])) continue;
    const title = rows[ti];
    const body = rows.slice(ti + 1)
      .filter(l => l && l !== '---' && l.replace(/^#+\s*/, '') !== title)
      .filter(l => !serviceFact.hasTime(l) && !PRICE_SUM_RE.test(l) && !serviceFact.MONEY_RE.test(l))
      .map(l => serviceFact.stripEmphasis(l).slice(0, MAX_LINE_CHARS)).filter(Boolean);
    // Метка фрагмента + столько строк, сколько влезает в общий кап. Ни одна
    // строка не влезла — фрагмент не берём вовсе (висячая метка без текста
    // читалась бы как «статья пустая»), и дальше смотреть незачем.
    const label = `«${title}»:`;
    let room = MAX_MEDICAL_CHARS - size - (label.length + 1);
    const take = [];
    for (const l of body) {
      if (l.length + 1 > room) break;
      take.push(l);
      room -= l.length + 1;
    }
    if (!take.length) { if (body.length) break; continue; }
    lines.push(label, ...take);
    size = MAX_MEDICAL_CHARS - room;
    if (!used.includes(title)) used.push(title);
    if (take.length < body.length) break;
  }
  if (!used.length) return null;
  return { titles: used, lines, raw: kb.context };
}
```

В `module.exports` добавить `pickMedicalFragments, MAX_MEDICAL_CHARS`.

- [ ] **Step 4: Запустить — проходит**

Run: `npx jest agent-medical-kb`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/medical-kb.js backend/agent-medical-kb.test.js
git commit -m "feat(agent): medical-kb — отбор фрагментов статьи без цен и времени

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `agent-rag.listArticleTitles`

**Files:**
- Modify: `services/agent-rag.js` (после `buildKnowledgeContext`, `module.exports`)
- Test: `agent-rag-io.test.js`

- [ ] **Step 1: Падающие тесты** — дописать в конец `agent-rag-io.test.js` (моки `db` там уже есть):

```js
describe('listArticleTitles', () => {
  beforeEach(() => rag._resetTitlesCache());

  test('опубликованные и не внутренние — тот же WHERE, что у поиска', async () => {
    db.any.mockResolvedValueOnce([{ title: ' Ботулинотерапия ' }, { title: '' }, { title: 'Биоревитализация и Мезотерапия' }]);
    const titles = await rag.listArticleTitles(1);
    expect(titles).toEqual(['Ботулинотерапия', 'Биоревитализация и Мезотерапия']);
    const [sql, params] = db.any.mock.calls[0];
    expect(sql).toMatch(/is_published\s*=\s*true/);
    expect(sql).toMatch(/internal_only\s*=\s*false/);
    expect(sql).toMatch(/salon_id\s*=\s*\$1/);
    expect(params).toEqual([1]);
  });

  test('кэш 60 с на салон', async () => {
    db.any.mockResolvedValue([{ title: 'A' }]);
    await rag.listArticleTitles(1, { nowMs: 1000 });
    await rag.listArticleTitles(1, { nowMs: 50000 });
    expect(db.any).toHaveBeenCalledTimes(1);
    await rag.listArticleTitles(2, { nowMs: 50000 });
    expect(db.any).toHaveBeenCalledTimes(2);
    await rag.listArticleTitles(1, { nowMs: 62000 });
    expect(db.any).toHaveBeenCalledTimes(3);
  });

  test('сбой БД бросает наружу (fail-open делает оркестратор) и не кэшируется', async () => {
    db.any.mockRejectedValueOnce(new Error('db down'));
    await expect(rag.listArticleTitles(1)).rejects.toThrow('db down');
    db.any.mockResolvedValueOnce([{ title: 'A' }]);
    await expect(rag.listArticleTitles(1)).resolves.toEqual(['A']);
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `npx jest agent-rag-io -t listArticleTitles`
Expected: FAIL — `rag._resetTitlesCache is not a function`.

- [ ] **Step 3: Реализация** — в `services/agent-rag.js` перед `module.exports`:

```js
// Заголовки опубликованных не внутренних статей — для медицинского предвызова
// (medical-kb.matchTitles). WHERE тот же, что у retrieveChunks. TTL-кэш 60 с
// на салон: зовётся на каждом медицинском ходу. Оркестратор зовёт через
// объект модуля (rag.listArticleTitles) — живой пробник подменяет его вместе с
// buildKnowledgeContext на прод-КБ.
const TITLES_TTL_MS = 60 * 1000;
const titlesCache = new Map();

async function listArticleTitles(salonId, opts = {}) {
  const now = opts.nowMs || Date.now();
  const hit = titlesCache.get(salonId);
  if (hit && now - hit.at < TITLES_TTL_MS) return hit.titles;
  const rows = await db.any(
    `SELECT title FROM kb_articles
      WHERE salon_id = $1 AND is_published = true AND internal_only = false
      ORDER BY id`, [salonId]);
  const titles = rows.map(r => String((r && r.title) || '').trim()).filter(Boolean);
  titlesCache.set(salonId, { at: now, titles });
  return titles;
}

function _resetTitlesCache() { titlesCache.clear(); }
```

В `module.exports` добавить `listArticleTitles, _resetTitlesCache`.

- [ ] **Step 4: Запустить — проходит**

Run: `npx jest agent-rag-io agent-rag`
Expected: PASS.

- [ ] **Step 5: Живой EXPLAIN не нужен** (простой SELECT по `salon_id`), но SQL проверить на дев-БД через MCP `mcp__postgres__query`:

```sql
SELECT title FROM kb_articles WHERE salon_id = 1 AND is_published = true AND internal_only = false ORDER BY id
```
Expected: ~29 строк на деве (на проде 40).

- [ ] **Step 6: Commit**

```bash
git add backend/services/agent-rag.js backend/agent-rag-io.test.js
git commit -m "feat(agent-rag): listArticleTitles — заголовки статей с кэшем 60 с

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Флаги в `config.js`

**Files:**
- Modify: `config.js` (после `AGENT_SERVICE_FACT_PREFETCH`)

- [ ] **Step 1: Добавить**

```js
  // Медицинский вопрос — статью КБ ищет код до ответа модели (medical-kb.js),
  // блок «СВЕДЕНИЯ ИЗ БАЗЫ ЗНАНИЙ ПО ВОПРОСУ ПАЦИЕНТА» в хвосте промпта.
  // 'false' + рестарт гасит; правила промпта флагом НЕ откатываются — без
  // предвызова правило «СНАЧАЛА БАЗА» велит модели искать в базе самой.
  AGENT_MEDICAL_KB_PREFETCH: process.env.AGENT_MEDICAL_KB_PREFETCH !== 'false',
  // Опасный признак после процедуры (кожа побелела, дыхание, зрение, жар…) —
  // перевод на администратора кодом, без базы и без модели. 'false' гасит.
  AGENT_MEDICAL_RED_FLAGS: process.env.AGENT_MEDICAL_RED_FLAGS !== 'false',
```

- [ ] **Step 2: Проверить**

Run: `node -e "const c=require('./config'); console.log(c.AGENT_MEDICAL_KB_PREFETCH, c.AGENT_MEDICAL_RED_FLAGS)"` → `true true`;
`AGENT_MEDICAL_RED_FLAGS=false node -e "console.log(require('./config').AGENT_MEDICAL_RED_FLAGS)"` → `false`.

- [ ] **Step 3: Commit**

```bash
git add backend/config.js
git commit -m "feat(config): флаги AGENT_MEDICAL_KB_PREFETCH и AGENT_MEDICAL_RED_FLAGS

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Промпт — правила 1/3 и раздел «МЕДИЦИНСКИЕ ГРАНИЦЫ»

Правка существующих правил, не новое правило (мораторий). Старые тесты «ни «да» ни «нет»» и «НЕМЕДЛЕННАЯ ЭСКАЛАЦИЯ» заменяются осознанно — это решения владельца 1–3.

**Files:**
- Modify: `services/agent/system-prompt.js` (правило 1 ≈ стр. 236, правило 3 ≈ стр. 238, раздел ≈ стр. 249–259)
- Test: `agent-system-prompt.test.js` (сьют `медицинские границы …` ≈ стр. 948–979)

- [ ] **Step 1: Переписать тесты** — сьют `describe('медицинские границы (показания/противопоказания/персональные вопросы)'` заменить целиком:

```js
// Аудит 2026-08-01 ввёл три уровня; решения владельца 13.10.2026 (спека
// 2026-10-13-mila-medical-kb-first-design.md) сделали базу знаний источником
// ответа и на ЛИЧНЫЕ вопросы и на жалобы. Прежние проверки «ни «да» ни «нет»»
// и «ОСЛОЖНЕНИЕ — НЕМЕДЛЕННАЯ ЭСКАЛАЦИЯ» заменены осознанно.
describe('медицинские границы (база знаний — единственный источник)', () => {
  const p = buildSystemPrompt({});
  const section = p.slice(p.indexOf('МЕДИЦИНСКИЕ ГРАНИЦЫ ('), p.indexOf('ЖАЛОБА ПОСЛЕ ПРОЦЕДУРЫ') + 1200);

  test('раздел на месте: сначала база, три уровня и жалоба, водораздел общий/персональный', () => {
    expect(p).toMatch(/МЕДИЦИНСКИЕ ГРАНИЦЫ \(источник ответа — ТОЛЬКО база знаний клиники/);
    for (const head of ['СНАЧАЛА БАЗА:', 'УРОВЕНЬ 1', 'УРОВЕНЬ 2', 'УРОВЕНЬ 3', 'ЖАЛОБА ПОСЛЕ ПРОЦЕДУРЫ']) {
      expect(section).toContain(head);
    }
    expect(section).toMatch(/ОБЩИЙ вопрос или ПЕРСОНАЛЬНЫЙ/);
  });
  test('сначала база: блок СВЕДЕНИЯ или собственный вызов, ничего из своих знаний, указания статьи выполняются', () => {
    expect(section).toContain('«СВЕДЕНИЯ ИЗ БАЗЫ ЗНАНИЙ ПО ВОПРОСУ ПАЦИЕНТА»');
    expect(section).toMatch(/сначала вызови search_knowledge_base/);
    expect(section).toMatch(/из своих знаний не добавляй никогда/i);
    expect(section).toMatch(/как поступать Миле[\s\S]{0,40}выполняй/);
  });
  test('уровень 2: дословно из статьи, всегда с оговоркой про врача; по памяти НИКОГДА', () => {
    expect(section).toMatch(/УРОВЕНЬ 2[\s\S]{0,400}дословн[\s\S]{0,300}врач/i);
    expect(section).toMatch(/не перечисляй противопоказания по памяти НИКОГДА/i);
  });
  test('уровень 3: по статье; молчание статьи — не разрешение; «в противопоказаниях этого нет» запрещено', () => {
    expect(section).not.toMatch(/ни «да» ни «нет»/);
    expect(section).toMatch(/при нём процедуру не проводят/);
    expect(section).toMatch(/Статья о состоянии пациента молчит — вывода не делай/);
    expect(section).toMatch(/не говори, что «в противопоказаниях этого нет»/);
    expect(section).toMatch(/УРОВЕНЬ 3[\s\S]{0,1200}консультаци/i);
    expect(section).toMatch(/беременность/i);
    expect(section).toMatch(/Эскалируй[\s\S]{0,120}ТОЛЬКО если пациент отказывается от консультации/i);
  });
  test('уровень 3 явно не конфликтует с «ЗАПРОС НА ПРОЦЕДУРУ ≠ КОНСУЛЬТАЦИЯ»', () => {
    expect(section).toMatch(/НЕ нарушение правила «ЗАПРОС НА ПРОЦЕДУРУ ≠ КОНСУЛЬТАЦИЯ»/);
  });
  test('жалоба: сначала база; обычная реакция — по статье; иначе без советов и escalate_to_operator в том же ходе', () => {
    expect(p).not.toMatch(/ОСЛОЖНЕНИЕ ПОСЛЕ ПРОЦЕДУРЫ — НЕМЕДЛЕННАЯ ЭСКАЛАЦИЯ/);
    expect(section).toMatch(/ЖАЛОБА ПОСЛЕ ПРОЦЕДУРЫ[\s\S]{0,200}тоже сначала база/);
    expect(section).toMatch(/обычную реакцию[\s\S]{0,200}в неё укладывается/);
    expect(section).toMatch(/дольше или сильнее описанного/);
    expect(section).toMatch(/статья велит передать врачу/);
    expect(section).toMatch(/есть сомнение/);
    expect(section).toMatch(/НИКАКИХ советов[\s\S]{0,200}escalate_to_operator/);
  });
  test('правила 1 и 3 ссылаются на базу и раздел', () => {
    expect(p).toMatch(/1\. Ты НЕ врач\.[^\n]*на медицинские вопросы и жалобы отвечаешь только тем, что есть в базе знаний клиники, — по разделу «МЕДИЦИНСКИЕ ГРАНИЦЫ»/);
    expect(p).not.toMatch(/не консультируешь по медицинским осложнениям/);
    expect(p).toMatch(/3\. МЕДИЦИНСКИЕ ВОПРОСЫ[^\n]*жалобы на состояние после процедуры/);
  });
  test('старые правила заменены: «сложный медицинский вопрос → администратор» удалён', () => {
    expect(p).not.toMatch(/Сложный медицинский вопрос, нестандартная услуга/);
    expect(p).not.toMatch(/ПОДГОТОВКА И РЕАБИЛИТАЦИЯ:/);
    expect(section).toMatch(/подготовка и уход после/i);
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `npx jest agent-system-prompt -t "медицинские границы"`
Expected: FAIL (старый текст раздела).

- [ ] **Step 3: Правка промпта** — в `services/agent/system-prompt.js`:

Правило 1:

```js
    `1. Ты НЕ врач. Ты никогда не ставишь диагнозы и не назначаешь препараты; на медицинские вопросы и жалобы отвечаешь только тем, что есть в базе знаний клиники, — по разделу «МЕДИЦИНСКИЕ ГРАНИЦЫ».`,
```

Правило 3:

```js
    `3. МЕДИЦИНСКИЕ ВОПРОСЫ (показания, противопоказания, подготовка, реабилитация, «а можно ли мне…», жалобы на состояние после процедуры) — отвечай СТРОГО по разделу «МЕДИЦИНСКИЕ ГРАНИЦЫ» ниже. Никогда не придумывай медицинские рекомендации.`,
```

Комментарий над разделом и сам раздел (5 строк от `МЕДИЦИНСКИЕ ГРАНИЦЫ (водораздел…` до `ОСЛОЖНЕНИЕ ПОСЛЕ ПРОЦЕДУРЫ…` включительно) заменить на:

```js
    // ── Медицинские границы: источник ответа — только база знаний клиники ──
    // Аудит 2026-08-01 ввёл три уровня (общий/персональный вопрос). Решения
    // владельца 13.10.2026 (спека 2026-10-13-mila-medical-kb-first-design.md):
    // личный вопрос и жалоба — тоже по базе; статья молчит — вывода нет («нет в
    // противопоказаниях» ≠ «можно»); норма/не норма после процедуры — по
    // описанию в статье, при сомнении перевод. Статью ищет КОД (medical-kb.js,
    // блок «СВЕДЕНИЯ…» в хвосте), опасные признаки переводит тоже код. Это
    // ПРАВКА существующего раздела, а не новое правило (мораторий CLAUDE.md).
    `МЕДИЦИНСКИЕ ГРАНИЦЫ (источник ответа — ТОЛЬКО база знаний клиники; водораздел — ОБЩИЙ вопрос или ПЕРСОНАЛЬНЫЙ):`,
    `СНАЧАЛА БАЗА: есть в конце инструкции блок «СВЕДЕНИЯ ИЗ БАЗЫ ЗНАНИЙ ПО ВОПРОСУ ПАЦИЕНТА» — отвечай по нему; блока нет или он о другой процедуре — сначала вызови search_knowledge_base. Медицинские факты, нормы, сроки и рекомендации из своих знаний не добавляй никогда. Если в статье написано, как поступать Миле в такой ситуации, — выполняй.`,
    `УРОВЕНЬ 1 — что это за процедура, как проходит, сколько длится, курс и интервалы, эффект и когда он виден, подготовка и уход после: отвечай по статье. Чего в статье нет — не досказывай: скажи, что этот вопрос уточнит врач, и предложи консультацию.`,
    `УРОВЕНЬ 2 — ОБЩИЙ вопрос о показаниях или противопоказаниях («какие противопоказания у ботокса?», «кому нельзя лазер?»): отвечай ТОЛЬКО дословным списком из статьи, ничего не добавляя от себя, и ВСЕГДА завершай мыслью, что окончательно возможность процедуры определяет врач на очной консультации. Статьи нет — не перечисляй противопоказания по памяти НИКОГДА, предложи консультацию врача.`,
    `УРОВЕНЬ 3 — ПЕРСОНАЛЬНЫЙ вопрос: пациент описывает СВОЁ состояние или ситуацию (беременность, грудное вскармливание, диабет, приём лекарств, аллергия, недавняя операция, кожное заболевание, герпес, перерыв в курсе и т.п.). Отвечай по статье: состояние прямо названо в противопоказаниях — скажи, что при нём процедуру не проводят; статья прямо допускает — можно сказать, что можно. Статья о состоянии пациента молчит — вывода не делай: ни «можно», ни «нельзя», и не говори, что «в противопоказаниях этого нет» (это звучит как разрешение); скажи, что это оценит врач на консультации, и если процедура подойдёт — её часто можно провести в тот же день. Это НЕ нарушение правила «ЗАПРОС НА ПРОЦЕДУРУ ≠ КОНСУЛЬТАЦИЯ»: то правило — про пациента, который просто не назвал препарат или зону; здесь же у пациента вопрос о его здоровье. Эскалируй на администратора ТОЛЬКО если пациент отказывается от консультации и настаивает на ответе прямо в чате.`,
    `ЖАЛОБА ПОСЛЕ ПРОЦЕДУРЫ («покраснело», «отёк», «болит», «синяк», «высыпало») — тоже сначала база. Если статья описывает это как обычную реакцию и описание пациента в неё укладывается (срок, выраженность, место) — коротко ответь по статье и попроси написать, если не пройдёт в указанный срок или станет хуже. Во всех остальных случаях — статья такого не описывает; длится дольше или сильнее описанного; появилось что-то новое; статья велит передать врачу; есть сомнение — НИКАКИХ советов и предложений записи: прояви сочувствие и в ТОМ ЖЕ ходе вызови escalate_to_operator, чтобы с пациентом как можно скорее связался врач.`,
```

- [ ] **Step 4: Запустить весь сьют промпта**

Run: `npx jest agent-system-prompt agent-system-prompt-v2`
Expected: PASS. Если упал чужой тест, ссылавшийся на старую фразу (`grep -n "НЕМЕДЛЕННАЯ\|ни «да» ни «нет»\|не консультируешь" *.test.js`), — обновить ожидание на новый текст и упомянуть это в коммите. v2 не меняется (вне рамок спеки).

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js
git commit -m "feat(agent): «МЕДИЦИНСКИЕ ГРАНИЦЫ» — источник ответа только база знаний

Решения владельца 13.10.2026: личный вопрос и жалоба после процедуры —
тоже по статье; молчание статьи — не разрешение. Правка существующего
раздела и правил 1/3, НЕ новое правило (мораторий): прежние проверки
«ни да ни нет» и «немедленная эскалация» заменены осознанно.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Промпт — блок «СВЕДЕНИЯ ИЗ БАЗЫ ЗНАНИЙ ПО ВОПРОСУ ПАЦИЕНТА»

**Files:**
- Modify: `services/agent/system-prompt.js` (разбор `opts` рядом с `serviceFact` ≈ стр. 169; хвост ≈ стр. 637–646)
- Test: `agent-system-prompt.test.js`

- [ ] **Step 1: Падающие тесты** — дописать в конец файла:

```js
describe('блок «СВЕДЕНИЯ ИЗ БАЗЫ ЗНАНИЙ ПО ВОПРОСУ ПАЦИЕНТА» (медицинский предвызов)', () => {
  const HEAD = 'СВЕДЕНИЯ ИЗ БАЗЫ ЗНАНИЙ ПО ВОПРОСУ ПАЦИЕНТА';
  const medicalKb = {
    titles: ['Биоревитализация и Мезотерапия'],
    lines: ['«Биоревитализация и Мезотерапия»:', '* Рекомендуется курс из 3–5 процедур с интервалом в 2–4 недели',
      'Приём с 10:00 до 21:00.', '* REVI EYE — 15 500 ₽', 'строка\nс переводом'],
  };
  // salesTail:false — сценарий продажи всегда последний и одинаков в обоих
  // промптах; без него инвариант формулируется без оговорок.
  const base = { lastUserText: 'Есть ли смысл делать био?', salesTail: false };
  const { TAIL_HEADER } = require('./services/agent/sales-modules');

  test('промпт без блока — префикс промпта с блоком (кэш провайдера)', () => {
    const without = buildSystemPrompt(base);
    const withBlock = buildSystemPrompt({ ...base, medicalKb });
    expect(withBlock.startsWith(without)).toBe(true);
    expect(withBlock).toContain(HEAD);
  });

  test('после справки об услуге, до сценария продажи', () => {
    // «не знаю, что выбрать» → сценарий undecided, у него есть модуль продажи
    // (у price модуля нет — SALES_MODULES = objection/undecided).
    const p = buildSystemPrompt({ lastUserText: 'Не знаю, что выбрать: био или мезо?', medicalKb,
      serviceFact: { title: 'Биоревитализация и Мезотерапия', text: 'Инъекционное введение препаратов.' } });
    const iFact = p.indexOf('СПРАВКА ОБ УСЛУГЕ');
    const iMed = p.indexOf(HEAD);
    const iSales = p.indexOf(TAIL_HEADER);
    expect(iFact).toBeGreaterThan(0);
    expect(iMed).toBeGreaterThan(iFact);
    expect(iSales).toBeGreaterThan(iMed);
  });

  test('заголовок, строки, инструкция; без ЧЧ:ММ и сумм; переводы строк схлопнуты', () => {
    const p = buildSystemPrompt({ ...base, medicalKb });
    const block = p.slice(p.indexOf(HEAD));
    expect(block).toContain(`${HEAD} (найдены автоматически; статья «Биоревитализация и Мезотерапия»):`);
    expect(block).toContain('* Рекомендуется курс из 3–5 процедур с интервалом в 2–4 недели');
    expect(block).toContain('Отвечай по правилу «МЕДИЦИНСКИЕ ГРАНИЦЫ» — только тем, что здесь написано.');
    expect(block).toContain('тот же запрос повторять не нужно');
    const own = block.slice(0, block.indexOf('тот же запрос повторять не нужно'));
    expect(own).not.toMatch(/\d{1,2}:\d{2}/);
    expect(own).not.toMatch(/₽/);
    expect(own).toContain('строка с переводом');
  });

  test('несколько статей — «статьи «…», «…»»', () => {
    const p = buildSystemPrompt({ ...base, medicalKb: { titles: ['A', 'B'], lines: ['«A»:', 'x'] } });
    expect(p).toContain(`${HEAD} (найдены автоматически; статьи «A», «B»):`);
  });

  test('пустые/битые данные — блока нет', () => {
    for (const m of [null, {}, { titles: ['A'], lines: [] }, { titles: ['A'], lines: ['Приём в 10:00.'] }]) {
      expect(buildSystemPrompt({ ...base, medicalKb: m })).not.toContain(HEAD);
    }
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `npx jest agent-system-prompt -t "СВЕДЕНИЯ ИЗ БАЗЫ"`
Expected: FAIL — блока нет.

- [ ] **Step 3: Реализация** — в `system-prompt.js`:

require вверху:

```js
const { PRICE_SUM_RE } = require('./reply-guard');
```

После разбора `serviceFact`:

```js
  // Сведения из КБ на медицинском вопросе (medical-kb.js, подкладывает
  // оркестратор). Строки с ЧЧ:ММ и суммами режем ещё раз здесь: блок стоит в
  // фактической части и засевает allowedTimes, а цены — только из каталога.
  const medicalKb = opts.medicalKb && typeof opts.medicalKb === 'object' && Array.isArray(opts.medicalKb.lines)
    ? {
      titles: (Array.isArray(opts.medicalKb.titles) ? opts.medicalKb.titles : [])
        .filter(t => !hasTime(t)).map(t => sanitizeLine(t, 120)).filter(Boolean),
      lines: opts.medicalKb.lines.filter(l => typeof l === 'string' && !hasTime(l) && !PRICE_SUM_RE.test(l))
        .map(l => sanitizeLine(l, 400)).filter(Boolean),
    } : null;
```

В хвосте — между блоком `serviceFact` и `...salesTail`:

```js
    // Сведения из КБ по медицинскому вопросу — после справки, до сценария
    // продажи: промпт без блока обязан остаться префиксом промпта с блоком.
    ...(medicalKb && medicalKb.lines.length ? [
      ``,
      `СВЕДЕНИЯ ИЗ БАЗЫ ЗНАНИЙ ПО ВОПРОСУ ПАЦИЕНТА (найдены автоматически${medicalKb.titles.length
        ? `; ${medicalKb.titles.length > 1 ? 'статьи' : 'статья'} ${medicalKb.titles.map(t => `«${t}»`).join(', ')}` : ''}):`,
      ...medicalKb.lines,
      `Отвечай по правилу «МЕДИЦИНСКИЕ ГРАНИЦЫ» — только тем, что здесь написано. Если сведения о другой процедуре или не отвечают на вопрос — вызови search_knowledge_base со своим запросом; тот же запрос повторять не нужно.`,
    ] : []),
```

Проверить, что `system-prompt.js` → `reply-guard` не даёт цикла: `node -e "require('./services/agent/system-prompt'); require('./services/agent/medical-kb'); console.log('ok')"`.

- [ ] **Step 4: Запустить — проходит**

Run: `npx jest agent-system-prompt agent-system-prompt-v2`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js
git commit -m "feat(agent): блок «СВЕДЕНИЯ ИЗ БАЗЫ ЗНАНИЙ ПО ВОПРОСУ ПАЦИЕНТА» в хвосте промпта

Данные с инструкцией к ним, как «СПРАВКА ОБ УСЛУГЕ», — не новое правило.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Reply-guard — телеметрия `medical_kb_unused`

**Files:**
- Modify: `services/agent/reply-guard.js` (после `checkQuestionInsteadOfOffer`, `module.exports`)
- Test: `agent-reply-guard.test.js`

- [ ] **Step 1: Падающие тесты** — дописать:

```js
describe('checkMedicalKbUsage (только лог)', () => {
  const { checkMedicalKbUsage, hardViolations } = require('./services/agent/reply-guard');
  const lines = ['«Биоревитализация и Мезотерапия»:', '* Рекомендуется курс из 3–5 процедур с интервалом в 2–4 недели'];
  const titles = ['Биоревитализация и Мезотерапия'];
  const patientText = 'Есть ли смысл делать био, если после второй процедуры прошло больше месяца?';

  test('ответ по блоку — нарушения нет', () => {
    expect(checkMedicalKbUsage('Обычно рекомендуют курс из 3–5 процедур с интервалом 2–4 недели.',
      { medicalKbLines: lines, titles, patientText })).toEqual([]);
  });

  test('ответ мимо блока — medical_kb_unused, мягкий тип', () => {
    const v = checkMedicalKbUsage('Это оценит врач на консультации.', { medicalKbLines: lines, titles, patientText });
    expect(v).toEqual([{ type: 'medical_kb_unused', value: 'Это оценит врач на консультации.' }]);
    expect(hardViolations(v)).toEqual([]);
  });

  test('общие слова с заголовком и с вопросом пациента не считаются использованием', () => {
    expect(checkMedicalKbUsage('Биоревитализация после второй процедуры — уточнит доктор.',
      { medicalKbLines: lines, titles, patientText })).toHaveLength(1);
  });

  test('блока не было — молчит', () => {
    expect(checkMedicalKbUsage('что угодно', { medicalKbLines: null })).toEqual([]);
    expect(checkMedicalKbUsage('что угодно', {})).toEqual([]);
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `npx jest agent-reply-guard -t checkMedicalKbUsage`
Expected: FAIL — `checkMedicalKbUsage is not a function`.

- [ ] **Step 3: Реализация** — в `reply-guard.js` после `checkQuestionInsteadOfOffer`:

```js
// ── Медицинский предвызов КБ (14.10.2026) — ТОЛЬКО ЛОГ ──────────────────────
// Блок «СВЕДЕНИЯ ИЗ БАЗЫ ЗНАНИЙ…» был, а в реплике нет ни одного содержательного
// стема (≥5 букв), общего со строками блока, — модель ответила мимо статьи.
// Слова заголовка статьи и вопроса пациента в сверку не идут: их модель
// повторила бы и без чтения блока. Не HARD_TYPES: сначала измерить.
// Своя токенизация, без service-fact: тот сам требует reply-guard (цикл).
const MED_STEM_LEN = 5;
const MED_STOP_PREFIXES = ['котор', 'может', 'можно', 'также', 'очень', 'тольк', 'здрав', 'пожал',
  'спаси', 'подск', 'напиш', 'сейча', 'обычн', 'клини'];
function medStems(text) {
  return new Set((String(text || '').toLowerCase().replace(/ё/g, 'е').match(/\p{L}{5,}/gu) || [])
    .map(w => w.slice(0, MED_STEM_LEN))
    .filter(s => !MED_STOP_PREFIXES.some(p => s.startsWith(p))));
}
function checkMedicalKbUsage(text, opts = {}) {
  const lines = Array.isArray(opts.medicalKbLines) ? opts.medicalKbLines : null;
  if (!lines || !lines.length) return [];
  const exclude = new Set([...medStems((opts.titles || []).join(' ')), ...medStems(opts.patientText)]);
  const block = [...medStems(lines.join(' '))].filter(s => !exclude.has(s));
  const reply = medStems(text);
  if (block.some(s => reply.has(s))) return [];
  return [{ type: 'medical_kb_unused', value: String(text || '').replace(/\s+/g, ' ').trim().slice(0, SALES_CLAUSE_CAP) }];
}
```

Внимание к тесту «ответ по блоку»: стемы «реком», «интер» блока совпадают с ответом; «курс»/«процедур» — 4/9 букв, «процедур» исключён вопросом пациента. В `module.exports` добавить `checkMedicalKbUsage`.

- [ ] **Step 4: Запустить — проходит**

Run: `npx jest agent-reply-guard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/reply-guard.js backend/agent-reply-guard.test.js
git commit -m "feat(agent): reply-guard — телеметрия medical_kb_unused (только лог)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Оркестратор — опасный признак

**Files:**
- Modify: `services/agent/orchestrator.js` (require ≈ стр. 22; ветка сразу ПОСЛЕ блока `if (cfg.AGENT_VISIT_RATING_REPLY …) { … }` и ДО `const evBuffer = toolEvents.createBuffer(…)` ≈ стр. 696–704)
- Test: `agent-orchestrator.test.js`

- [ ] **Step 1: Падающие тесты** — дописать в конец `agent-orchestrator.test.js`:

```js
describe('опасный признак после процедуры — перевод кодом, без модели', () => {
  const rfDeps = (text, extra = {}) => makeDeps({
    history: { loadTranscript: jest.fn(async () => ({ messages: [{ role: 'user', content: text }], watermark: 700 })) },
    ...extra,
  });

  test('«побелела кожа» → escalate, готовый текст, провайдер и журнал не трогаются', async () => {
    const deps = rfDeps('После филлера побелела кожа на губе');
    const res = await orchestrator.runDialog(1, '79001112233', { deps, now: '12:00' });
    expect(deps.provider.createMessage).not.toHaveBeenCalled();
    expect(deps.registry.handlers.escalate_to_operator).toHaveBeenCalledWith(
      1, { reason: 'опасный признак после процедуры (skin_blanching)' }, expect.any(Object));
    expect(res).toMatchObject({ escalated: true, sideEffect: true });
    expect(res.replies).toEqual([require('./services/agent/medical-kb').buildRedFlagReply({ adminOff: false })]);
    expect(deps.state.setWatermark).toHaveBeenCalledWith(1, '79001112233', 700);
    expect(deps.toolEvents.createBuffer).not.toHaveBeenCalled();
  });

  test('ночью — вариант с 103/112', async () => {
    const deps = rfDeps('задыхаюсь после укола');
    const res = await orchestrator.runDialog(1, 'k', { deps, now: '23:30' });
    expect(res.replies[0]).toMatch(/103 или 112/);
  });

  test('перевод не записался → ход к модели, ватермарк ставит штатный путь', async () => {
    const deps = rfDeps('После филлера побелела кожа на губе');
    deps.registry.handlers.escalate_to_operator = jest.fn(async () => { throw new Error('db down'); });
    deps.provider.createMessage.mockResolvedValue(textResp('Ответ'));
    const res = await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.provider.createMessage).toHaveBeenCalled();
    expect(res.replies).toEqual(['Ответ']);
  });

  test('escalated:false → тоже к модели', async () => {
    const deps = rfDeps('задыхаюсь', { handlers: { escalate_to_operator: jest.fn(async () => ({ escalated: false })) } });
    deps.provider.createMessage.mockResolvedValue(textResp('Ответ'));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.provider.createMessage).toHaveBeenCalled();
  });

  test('AGENT_MEDICAL_RED_FLAGS=false → к модели, без эскалации кодом', async () => {
    const deps = rfDeps('задыхаюсь');
    deps.config = { ...require('./config'), AGENT_MEDICAL_RED_FLAGS: false };
    deps.provider.createMessage.mockResolvedValue(textResp('Ответ'));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.registry.handlers.escalate_to_operator).not.toHaveBeenCalled();
    expect(deps.provider.createMessage).toHaveBeenCalled();
  });

  test('обычная жалоба без опасного признака → к модели', async () => {
    const deps = rfDeps('После Lumecca покраснение 2 дня, это нормально?');
    deps.provider.createMessage.mockResolvedValue(textResp('Ответ'));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.registry.handlers.escalate_to_operator).not.toHaveBeenCalled();
    expect(deps.provider.createMessage).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `npx jest agent-orchestrator -t "опасный признак"`
Expected: FAIL — провайдер вызывается, эскалации нет.

- [ ] **Step 3: Реализация** — в `orchestrator.js`:

require рядом с `serviceFactMod`:

```js
const medicalKbMod = require('./medical-kb');
```

Ветка после блока оценки визита, перед комментарием «Буфер журнала tool-цикла этой ПОПЫТКИ»:

```js
    // Опасный признак после процедуры (кожа побелела, трудно дышать, зрение,
    // жар/гной/нарастающая боль после процедуры) — перевод на администратора
    // КОДОМ, без базы и без модели (спека 2026-10-13-mila-medical-kb-first,
    // решение владельца №5; список признаков утверждает врач). Приём тот же,
    // что у низкой оценки визита: эскалация — УСЛОВИЕ готового текста (он сам
    // объявляет перевод, HANDOVER_ANNOUNCED_RE), не записалась — ход идёт к
    // модели, и правило «ЖАЛОБА ПОСЛЕ ПРОЦЕДУРЫ» переведёт сама. Стоит ДО
    // буфера журнала: ход без инструментов модели записи не заводит.
    if (cfg.AGENT_MEDICAL_RED_FLAGS && registry.handlers['escalate_to_operator']) {
      const lastUserRf = [...messages].reverse().find(m => m && m.role === 'user');
      const flag = medicalKbMod.detectRedFlag(lastUserRf && typeof lastUserRf.content === 'string'
        ? lastUserRf.content : '');
      if (flag) {
        let escalatedOk = false;
        try {
          const res = await registry.handlers['escalate_to_operator'](salonId,
            { reason: `опасный признак после процедуры (${flag.kind})` }, toolCtx);
          escalatedOk = !!(res && res.escalated);
        } catch (e) {
          logger.error(`dialog ${dialogKey}: эскалация по опасному признаку не записалась (${e.message})`);
        }
        if (escalatedOk) {
          logger.warn(`dialog ${dialogKey}: опасный признак после процедуры (${flag.kind}) — перевод на администратора без LLM`);
          await state.setWatermark(salonId, dialogKey, watermark);
          return { replies: [medicalKbMod.buildRedFlagReply({ adminOff: promptOpts.adminOffHours })],
            escalated: true, sideEffect: true };
        }
        logger.error(`dialog ${dialogKey}: опасный признак (${flag.kind}) — перевод не состоялся, отдаю ход модели`);
      }
    }
```

- [ ] **Step 4: Запустить — проходит, соседние сьюты целы**

Run: `npx jest agent-orchestrator agent-dispatcher`
Expected: PASS. Если упал старый тест с текстом-жалобой («задыхаюсь», «побелела» и т.п.), значит фикстура задела признак — изменить её текст, а не детектор.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/orchestrator.js backend/agent-orchestrator.test.js
git commit -m "feat(agent): опасный признак после процедуры — перевод кодом без модели

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Оркестратор — медицинский предвызов КБ

**Files:**
- Modify: `services/agent/orchestrator.js`:
  - require `ragDefault`;
  - переменные хода рядом с `serviceFact*` (≈ стр. 597–600);
  - запись сырого ответа в блоке справки (≈ стр. 762–771);
  - предвызов после `if (serviceFactKb) evBuffer.push(…)` (≈ стр. 780);
  - `promptBuilder({…})` (≈ стр. 903–908);
  - `kbSourceText` и `turnCallCache` (≈ стр. 1057–1071);
  - `lint` (≈ стр. 1510, блок `salesTelemetry`).
- Test: `agent-orchestrator.test.js`

- [ ] **Step 1: Падающие тесты** — дописать:

```js
describe('медицинский вопрос — база знаний предвызовом кода', () => {
  const HEAD = 'СВЕДЕНИЯ ИЗ БАЗЫ ЗНАНИЙ ПО ВОПРОСУ ПАЦИЕНТА';
  const { medicalSearchResult, PROD_TITLES } = require('./services/agent/__fixtures__/kb-medical-chunks');
  const Q1013 = 'Есть ли вообще смысл делать био, если после второй процедуры прошло больше месяца?';

  function medDeps(text, kbResult, { te, titles = PROD_TITLES } = {}) {
    const kbHandler = jest.fn(async () => kbResult);
    const deps = makeDeps({
      history: { loadTranscript: jest.fn(async () => ({ messages: [{ role: 'user', content: text }], watermark: 900 })) },
      handlers: { search_knowledge_base: kbHandler },
      ...(te ? { toolEvents: te } : {}),
    });
    deps.rag = { listArticleTitles: jest.fn(async () => titles) };
    deps.provider.createMessage.mockResolvedValue(textResp('Ответ'));
    return { deps, kbHandler };
  }
  const systemOf = (deps, i = 0) => deps.provider.createMessage.mock.calls[i][0].system;

  test('вопрос 13.10 → КБ вызвана кодом, в промпте статья #16 без чужой статьи', async () => {
    const { deps, kbHandler } = medDeps(Q1013, medicalSearchResult(['bio0', 'laser', 'bio1']));
    await orchestrator.runDialog(1, '79001112233', { deps });
    expect(deps.rag.listArticleTitles).toHaveBeenCalledWith(1);
    expect(kbHandler).toHaveBeenCalledWith(1, { query: Q1013 }, expect.any(Object));
    const block = systemOf(deps).slice(systemOf(deps).indexOf(HEAD));
    expect(block).toContain('статья «Биоревитализация и Мезотерапия»');
    expect(block).toContain('курс из 3–5 процедур с интервалом в 2–4 недели');
    expect(block).not.toContain('Pacer');
    expect(block).not.toMatch(/₽/);
  });

  test('процедура в предыдущем сообщении — запрос «то + последнее»', async () => {
    const { deps, kbHandler } = medDeps('', medicalSearchResult(['bio0']));
    deps.history.loadTranscript = jest.fn(async () => ({ watermark: 900, messages: [
      { role: 'user', content: 'Хочу на биоревитализацию' },
      { role: 'assistant', content: 'Подскажу!' },
      { role: 'user', content: 'А при диабете можно?' },
    ] }));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(kbHandler).toHaveBeenCalledWith(1, { query: 'Хочу на биоревитализацию А при диабете можно?' }, expect.any(Object));
    expect(systemOf(deps)).toContain(HEAD);
  });

  test('найдено не о той процедуре → блока нет', async () => {
    const { deps } = medDeps(Q1013, medicalSearchResult(['laser']));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(systemOf(deps)).not.toContain(HEAD);
  });

  test('процедура не определена → КБ не вызывается', async () => {
    const { deps, kbHandler } = medDeps('у меня бугорок', medicalSearchResult(['lips']));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(kbHandler).not.toHaveBeenCalled();
  });

  test('не медицинский вопрос → ни заголовков, ни КБ', async () => {
    const { deps, kbHandler } = medDeps('Запишите на пятницу', medicalSearchResult(['bio0']));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.rag.listArticleTitles).not.toHaveBeenCalled();
    expect(kbHandler).not.toHaveBeenCalled();
  });

  test.each([
    ['заголовки упали', (d) => { d.rag.listArticleTitles = jest.fn(async () => { throw new Error('db down'); }); }],
    ['КБ упала', (d) => { d.registry.handlers.search_knowledge_base = jest.fn(async () => { throw new Error('rag down'); }); }],
    ['КБ зависла', (d) => { d.registry.handlers.search_knowledge_base = jest.fn(() => new Promise(() => {})); d.serviceFactTimeoutMs = 20; }],
    ['заголовки зависли', (d) => { d.rag.listArticleTitles = jest.fn(() => new Promise(() => {})); d.serviceFactTimeoutMs = 20; }],
    ['ответ без fragments', (d) => { d.registry.handlers.search_knowledge_base = jest.fn(async () => ({ found: true, context: 'Биоревитализация и Мезотерапия\nтекст', sources: [] })); }],
  ])('%s → ход штатный, без блока', async (_label, breakIt) => {
    const { deps } = medDeps(Q1013, medicalSearchResult(['bio0']));
    breakIt(deps);
    const res = await orchestrator.runDialog(1, 'k', { deps });
    expect(res.replies).toEqual(['Ответ']);
    expect(systemOf(deps)).not.toContain(HEAD);
  });

  test('журнал попытки получает событие search_knowledge_base', async () => {
    const te = makeToolEventsStub();
    const kb = medicalSearchResult(['bio0']);
    const { deps } = medDeps(Q1013, kb, { te });
    await orchestrator.runDialog(1, 'k', { deps });
    expect(te.buffers[0].push).toHaveBeenCalledWith('search_knowledge_base', { query: Q1013 }, kb, false);
  });

  test('модель повторила тот же запрос → второго похода в КБ нет', async () => {
    const { deps, kbHandler } = medDeps(Q1013, medicalSearchResult(['bio0']));
    deps.provider.createMessage.mockReset();
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('search_knowledge_base', { query: Q1013 }))
      .mockResolvedValueOnce(textResp('Ответ'));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(kbHandler).toHaveBeenCalledTimes(1);
  });

  test('вопрос и о цене, и медицинский → один поиск на справку и сведения', async () => {
    const text = 'Сколько стоит био при беременности?';
    const { deps, kbHandler } = medDeps(text, medicalSearchResult(['bio0', 'bio1']));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(kbHandler).toHaveBeenCalledTimes(1);
    expect(systemOf(deps)).toContain(HEAD);
  });

  test('перегенерация с тем же вопросом → КБ один раз, блок на обеих попытках', async () => {
    const { deps, kbHandler } = medDeps(Q1013, medicalSearchResult(['bio0']));
    let checks = 0;
    deps.history.hasIncomingAfter = jest.fn(async () => (++checks === 1));
    deps.provider.createMessage.mockReset();
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Первый')).mockResolvedValueOnce(textResp('Второй'));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(kbHandler).toHaveBeenCalledTimes(1);
    expect(systemOf(deps, 1)).toContain(HEAD);
  });

  test('адрес из статьи сведений — законный источник address-guard', async () => {
    const kb = medicalSearchResult(['bio0']);
    kb.context += '\n\nБиоревитализация и Мезотерапия\nАдрес: ул. Генерала Белова, 28 к. 3.';
    kb.fragments.push({ article_id: 16, start: kb.context.lastIndexOf('Биоревитализация'), end: kb.context.length });
    const { deps } = medDeps(Q1013, kb);
    deps.provider.createMessage.mockResolvedValue(textResp('Курс 3–5 процедур. Наш адрес: ул. Генерала Белова, 28 к. 3.'));
    const res = await orchestrator.runDialog(1, 'k', { deps });
    expect(res.replies.join(' ')).toContain('Генерала Белова, 28');
  });

  test('AGENT_MEDICAL_KB_PREFETCH=false → предвызова нет', async () => {
    const { deps, kbHandler } = medDeps(Q1013, medicalSearchResult(['bio0']));
    deps.config = { ...require('./config'), AGENT_MEDICAL_KB_PREFETCH: false };
    await orchestrator.runDialog(1, 'k', { deps });
    expect(kbHandler).not.toHaveBeenCalled();
  });

  test('v2 → предвызова нет', async () => {
    const { deps, kbHandler } = medDeps(Q1013, medicalSearchResult(['bio0']));
    deps.config = { ...require('./config'), AGENT_PROMPT_VERSION: 'v2', AGENT_CATALOG_IN_PROMPT: false };
    await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.rag.listArticleTitles).not.toHaveBeenCalled();
    expect(kbHandler).not.toHaveBeenCalled();
  });

  test('ответ мимо сведений → medical_kb_unused в логе reply-guard', async () => {
    const { deps } = medDeps(Q1013, medicalSearchResult(['bio0']));
    deps.provider.createMessage.mockResolvedValue(textResp('Это оценит доктор на приёме.'));
    mockLogger.warn.mockClear();
    await orchestrator.runDialog(1, 'k', { deps });
    expect(mockLogger.warn.mock.calls.some(c => /medical_kb_unused/.test(c[0]))).toBe(true);
  });
});
```

Там же — дефолт `rag` в `makeDeps` (рядом с `priceListData`). Без него старые сьюты, где в сообщении есть медицинский маркер и в `handlers` есть `search_knowledge_base`, пойдут в настоящий `agent-rag.listArticleTitles` → БД:

```js
    // Заголовки статей КБ для медицинского предвызова ходят в БД — стаб
    // «статей нет»: процедура не определится, блока не будет.
    rag: { listArticleTitles: jest.fn(async () => []), ...overrides.rag },
```

`medDeps` своим `deps.rag = …` перекрывает дефолт.

Перед запуском свериться: тест address-guard опирается на то, что `scrubAddresses` пропускает адрес, слова и номера которого есть в `kbSourceText`. Если на деле address-guard не пропускает «28 к. 3» из-за формы (см. существующий сьют «адрес клиники без источника» ≈ стр. 600), взять формулировку адреса из того сьюта.

- [ ] **Step 2: Запустить — падает**

Run: `npx jest agent-orchestrator -t "медицинский вопрос"`
Expected: FAIL — `listArticleTitles` не вызывается, блока нет.

- [ ] **Step 3: Реализация** — в `orchestrator.js`:

(а) require рядом с `listBookingsDefault`:

```js
const ragDefault = require('../agent-rag');
```

(б) Переменные хода — сразу после `let serviceFactCheckedQuery = null;`:

```js
  // Сырые ответы КБ предвызовов этого хода по тексту запроса: медицинский
  // предвызов берёт результат справки об услуге, если запрос совпал (второго
  // поиска нет). Переживает перегенерации, как и сами предвызовы.
  const kbPrefetchRaw = new Map();
  let medicalKb = null;            // { titles, lines, raw } из medical-kb.pickMedicalFragments
  let medicalKbResult = null;      // сырой ответ инструмента — журнал, кэш повторов, address-guard
  let medicalKbQuery = null;       // { query } — аргументы для журнала и кэша
  let medicalCheckedKey;           // kbQuery последнего сообщения, по которому уже решали (undefined — ещё нет)
```

(в) В блоке справки, сразу после `const kb = await serviceFactMod.withTimeout(…);`:

```js
            if (kb && kb.found) kbPrefetchRaw.set(curFactQuery, kb);
```

(г) Предвызов — после строки `if (serviceFactKb) evBuffer.push('search_knowledge_base', serviceFactQuery, serviceFactKb, false);`:

```js
    // Медицинский вопрос — статью КБ ищет код до первого прохода провайдера
    // (medical-kb.js; спека 2026-10-13-mila-medical-kb-first). Живой прогон
    // 13.10: модель 3/3 не звала КБ, хотя прямой ответ был в статье. Порядок:
    // детектор → заголовки статей → запрос (процедура из этого или предыдущего
    // сообщения) → поиск → отбор фрагментов нужной статьи. Ключ — kbQuery
    // ТЕКУЩЕГО последнего сообщения (как у справки): перегенерация с тем же
    // вопросом в КБ не идёт, с другим — блок сбрасывается. Заголовки и поиск
    // под ОДНИМ таймаутом: listArticleTitles — запрос в БД, и зависший пул не
    // должен держать ход. Любой сбой → без блока, ход как до фичи (fail-open):
    // правило «СНАЧАЛА БАЗА» велит модели искать самой. v2 блок не рендерит.
    if (cfg.AGENT_MEDICAL_KB_PREFETCH && cfg.AGENT_PROMPT_VERSION !== 'v2') {
      const userBlocks = [...messages].reverse()
        .filter(m => m && m.role === 'user' && typeof m.content === 'string')
        .slice(0, 3).map(m => stripAllStamps(m.content));
      const lastMedText = userBlocks[0] || '';
      const curMedKey = medicalKbMod.wantsMedicalKb(lastMedText) ? serviceFactMod.kbQuery(lastMedText) : null;
      if (curMedKey !== medicalCheckedKey) {
        medicalKb = null;
        medicalKbResult = null;
        medicalKbQuery = null;
        medicalCheckedKey = curMedKey;
        if (curMedKey && registry.handlers['search_knowledge_base']) {
          let found = null;
          try {
            found = await serviceFactMod.withTimeout((async () => {
              const titles = await (d.rag || ragDefault).listArticleTitles(salonId);
              const q = medicalKbMod.buildMedicalQuery(userBlocks, titles);
              if (!q) return { outcome: 'процедура не определена' };
              let kb = kbPrefetchRaw.get(q.query);
              if (!kb) {
                kb = await registry.handlers['search_knowledge_base'](salonId, { query: q.query }, toolCtx);
                if (kb && kb.found) kbPrefetchRaw.set(q.query, kb);
              }
              if (!kb || !kb.found) return { outcome: kb && kb.degraded ? 'база не ответила' : 'ничего не найдено' };
              const picked = medicalKbMod.pickMedicalFragments(kb, q.titles);
              if (!picked) return { outcome: 'найдено не о той процедуре' };
              return { picked, kb, query: { query: q.query },
                outcome: `статья ${picked.titles.map(t => `«${t}»`).join(', ')}` };
            })(), d.serviceFactTimeoutMs || serviceFactMod.SERVICE_FACT_TIMEOUT_MS, 'medical KB');
          } catch (e) {
            found = { outcome: `база не ответила (${e.message})` };
          }
          if (found.picked) {
            medicalKb = found.picked;
            medicalKbResult = found.kb;
            medicalKbQuery = found.query;
          }
          logger.info(`dialog ${dialogKey}: медицинский вопрос — сведения из базы: ${found.outcome}`);
        }
      }
    }
    // В журнал — на КАЖДОЙ попытке (буфер пересоздаётся). Общий со справкой
    // поиск уже записан строкой выше — второй строкой его не дублируем.
    if (medicalKbResult && medicalKbResult !== serviceFactKb) {
      evBuffer.push('search_knowledge_base', medicalKbQuery, medicalKbResult, false);
    }
```

Почему результат возвращается из async-функции, а не пишется в переменные хода изнутри неё: после таймаута `withTimeout` отпускает ход, но сама функция продолжает работать — запись изнутри могла бы лечь ПОСЛЕ `catch` и всплыть на следующей перегенерации как блок, которого этот ход не дождался.

(д) `promptBuilder({…})` — добавить после `serviceFact,`:

```js
      medicalKb: medicalKb ? { titles: medicalKb.titles, lines: medicalKb.lines } : null,
```

(е) После строки `if (serviceFactKb && typeof serviceFactKb.context === 'string') kbSourceText += …;`:

```js
    // Сведения медицинского предвызова — тоже законный источник адреса
    // (address-guard); сырой context, не JSON.stringify (готча promo).
    if (medicalKbResult && medicalKbResult !== serviceFactKb && typeof medicalKbResult.context === 'string') {
      kbSourceText += `\n${medicalKbResult.context}`;
    }
```

После `if (serviceFactKb) turnCallCache.set(…);`:

```js
    if (medicalKbResult) turnCallCache.set(repeatCallKey('search_knowledge_base', medicalKbQuery), medicalKbResult);
```

(ж) В `lint`, внутри `...(salesTelemetry ? [ … ] : [])` дописать третьим элементом:

```js
          // Медицинский предвызов (14.10.2026): блок был, ответ мимо — только лог.
          ...replyGuard.checkMedicalKbUsage(joined, {
            medicalKbLines: medicalKb ? medicalKb.lines : null,
            titles: medicalKb ? medicalKb.titles : [],
            patientText: toolCtx.patientLastText,
          }),
```

- [ ] **Step 4: Запустить — проходит**

Run: `npx jest agent-orchestrator`
Expected: PASS весь файл.

- [ ] **Step 5: Связанные наборы**

Run: `npx jest agent-orchestrator agent-dispatcher agent-false-success agent-service-fact agent-medical-kb agent-system-prompt agent-reply-guard agent-rag-io agent-followup-worker agent-price-followthrough agent-tools`
Expected: PASS. Если тест в ДРУГОМ файле зовёт `runDialog` с медицинским текстом и КБ-хендлером без `deps.rag` — ход уйдёт в реальную БД и будет ограничен таймаутом 8 с (тест замедлится или упадёт по таймауту jest). Лечить стабом `rag` в deps этого теста.

- [ ] **Step 6: Commit**

```bash
git add backend/services/agent/orchestrator.js backend/agent-orchestrator.test.js
git commit -m "feat(agent): медицинский вопрос — статью КБ ищет код до ответа модели

Живой прогон 13.10.2026: на вопрос о курсе биоревитализации модель 3/3
не звала КБ, хотя ответ был в статье #16. Предвызов как у справки об
услуге: ключ по запросу, журнал, кэш повторов, источник address-guard;
совпавший запрос берётся из поиска справки. Fail-open, флаг
AGENT_MEDICAL_KB_PREFETCH. Телеметрия medical_kb_unused — только лог.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Живой пробник `scripts/agent-medical-kb-probe.js`

Платный LLM. Ничего не отправляет (нет диспетчера). Прод-БД — только чтение. Запускать на деве с владельцем или по его разрешению.

**Files:**
- Create: `scripts/agent-medical-kb-probe.js`

- [ ] **Step 1: Создать скрипт**

```js
#!/usr/bin/env node
'use strict';
// Живая проверка медицинского предвызова КБ (спека
// docs/superpowers/specs/2026-10-13-mila-medical-kb-first-design.md).
// Настоящий orchestrator.runDialog без диспетчера — НИЧЕГО НЕ ОТПРАВЛЯЕТСЯ.
// Модель — codex (как прод-мост gpt). База знаний — ПРОД-БД loyalpro
// read-only: дев-КБ отстаёт (29 статей против 40). Write-инструменты
// заглушены, синтетический номер, история чистится до и после. След
// каждого хода — /tmp/agent-medical-kb-probe/<case>-<run>.json.
//
// ВНИМАНИЕ: платный LLM (~16 ходов). Usage (из backend/):
//   PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH node scripts/agent-medical-kb-probe.js [--runs 2] [--only <id>]
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db, pool } = require('../db');
const { Pool } = require('pg');
const orchestrator = require('../services/agent/orchestrator');
const registry = require('../services/agent/tools');
const providers = require('../services/agent/providers');
const realRag = require('../services/agent-rag');

const SALON = 1;
const CHANNEL = 'whatsapp';
const PHONE = '79000000941';
const OUT = '/tmp/agent-medical-kb-probe';
const argv = process.argv.slice(2);
const RUNS = Number((argv[argv.indexOf('--runs') + 1]) || 2) || 2;
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

// expectAny — хотя бы одно из (регистр не важен); bad — ни одного; escalated —
// ожидаемый флаг результата; redFlag — модель не вызывается вовсе.
const CASES = [
  { id: 'bio-gap', text: 'Есть ли вообще смысл делать био, если после второй процедуры прошло больше месяца?',
    expectAny: ['3–5', '3-5', '2–4', '2-4'], bad: [], escalated: false },
  { id: 'bio-lactation', text: 'Кормлю грудью, можно мне био?',
    expectAny: ['лактац', 'грудн', 'не проводят', 'нельзя'], bad: ['можно сделать'], escalated: false },
  { id: 'bio-diabetes', text: 'У меня диабет, можно био?',
    expectAny: ['врач', 'консультац'], bad: ['диабета нет', 'нет в противопоказаниях', 'не входит в противопоказания', 'да, можно', 'можно делать'], escalated: false },
  { id: 'laser-pain', text: 'Как проходит лазерная эпиляция, больно?',
    expectAny: ['без боли', 'безболезн', 'shr'], bad: [], escalated: false },
  { id: 'lumecca-2d', text: 'После Lumecca покраснение 2 дня, это нормально?',
    expectAny: ['1–3', '1-3', 'до трёх', 'обычн'], bad: [], escalated: false },
  { id: 'lumecca-6d', text: 'После Lumecca покраснение уже 6 дней, не проходит',
    expectAny: ['администратор', 'врач'], bad: [], escalated: true },
  { id: 'lips-bump', text: 'После губ бугорок',
    expectAny: ['администратор', 'врач'], bad: ['массаж', 'мазь'], escalated: true },
  { id: 'filler-blanch', text: 'После филлера побелела кожа на губе',
    expectAny: ['администратор'], bad: [], escalated: true, redFlag: true },
];

const prodUrl = new URL(config.DATABASE_URL); prodUrl.pathname = '/loyalpro';
const prodPool = new Pool({ connectionString: prodUrl.toString(), max: 3,
  options: '-c default_transaction_read_only=on' });
const rows = async (s, p) => (await prodPool.query(s, p)).rows;
const prodDb = { query: (s, p) => prodPool.query(s, p), any: rows, many: rows,
  one: async (s, p) => (await rows(s, p))[0] || null, oneOrNone: async (s, p) => (await rows(s, p))[0] || null };

// Частная копия agent-rag.js с ../db = прод; остальные модули держат дев-БД.
function loadProdRag() {
  const dbPath = require.resolve('../db');
  const ragPath = require.resolve('../services/agent-rag');
  const dbMod = require.cache[dbPath];
  const saved = dbMod.exports;
  const savedRag = require.cache[ragPath];
  dbMod.exports = { ...saved, db: prodDb, pool: prodPool };
  delete require.cache[ragPath];
  try { return require(ragPath); } finally { dbMod.exports = saved; require.cache[ragPath] = savedRag; }
}
const prodRag = loadProdRag();
realRag.buildKnowledgeContext = prodRag.buildKnowledgeContext;
realRag.listArticleTitles = prodRag.listArticleTitles;

const WRITE_RE = /^(create_booking|book_chain|modify_booking_services|reschedule_booking|cancel_booking)$/;
function wrapRegistry(toolLog) {
  const base = config.AGENT_CATALOG_IN_PROMPT ? registry.catalogMode : registry;
  const handlers = {};
  for (const [name, fn] of Object.entries(base.handlers)) {
    handlers[name] = async (salonId, input, ctx) => {
      const ev = { name, input };
      toolLog.push(ev);
      if (WRITE_RE.test(name)) return (ev.result = { created: false, error: 'stub: пробник ничего не записывает' });
      if (name === 'escalate_to_operator') return (ev.result = { escalated: true, reason: input && input.reason });
      ev.result = await fn(salonId, input, ctx);
      return ev.result;
    };
  }
  return { ...base, schemas: base.schemas, handlers };
}

const real = providers.getProvider('codex');
function wrapProvider(llmLog) {
  return { MODEL: real.MODEL, toolResultMessages: r => real.toolResultMessages(r),
    async createMessage(req, opts) {
      const ev = { system: Array.isArray(req.system) ? req.system.map(b => b.text || '').join('\n') : String(req.system || '') };
      llmLog.push(ev);
      ev.response = await real.createMessage(req, opts);
      return ev.response;
    } };
}

async function cleanup() {
  await db.query(`DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_tool_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]).catch(() => {});
  await db.query(`DELETE FROM agent_followups WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]).catch(() => {});
}

async function runCase(c, run) {
  await cleanup();
  const ts = Math.floor(Date.now() / 1000);
  await db.query(
    `INSERT INTO chatpush_messages (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, msg_ts)
     VALUES ($1,$2,$3,'incoming',$4,'text',$5,$6,$7)`,
    [SALON, config.CHATPUSH.customerId || null, CHANNEL, `probe:${PHONE}:${ts}:${c.id}`, c.text, PHONE, ts]);
  const toolLog = [];
  const llmLog = [];
  let res; let err;
  try {
    res = await orchestrator.runDialog(SALON, PHONE, { ctx: { phone: PHONE, channel: CHANNEL },
      deps: { registry: wrapRegistry(toolLog), provider: wrapProvider(llmLog) } });
  } catch (e) { err = e; }
  await cleanup();
  const reply = (res && res.replies || []).join(' ');
  const low = reply.toLowerCase();
  const blockSeen = llmLog.some(l => l.system.includes('СВЕДЕНИЯ ИЗ БАЗЫ ЗНАНИЙ ПО ВОПРОСУ ПАЦИЕНТА'));
  const kbCalled = toolLog.some(t => t.name === 'search_knowledge_base');
  const checks = {
    kb: c.redFlag ? true : (blockSeen || kbCalled),
    expect: c.expectAny.some(w => low.includes(w.toLowerCase())),
    bad: !c.bad.some(w => low.includes(w.toLowerCase())),
    escalated: !!(res && res.escalated) === c.escalated,
    noModel: c.redFlag ? llmLog.length === 0 : true,
    noError: !err,
  };
  fs.writeFileSync(path.join(OUT, `${c.id}-${run}.json`), JSON.stringify({ case: c, res, err: err && err.message,
    blockSeen, tools: toolLog, llm: llmLog }, null, 1));
  return { ok: Object.values(checks).every(Boolean), checks, reply };
}

async function main() {
  const chk = (await prodPool.query(`SELECT current_database() db, current_setting('default_transaction_read_only') ro`)).rows[0];
  if (chk.db !== 'loyalpro' || chk.ro !== 'on') throw new Error(`прод-пул не read-only: ${JSON.stringify(chk)}`);
  if (new URL(config.DATABASE_URL).pathname !== '/loyalpro_test') throw new Error('диалоговая БД пробника обязана быть дев (loyalpro_test)');
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`модель=${real.MODEL} промпт=${config.AGENT_PROMPT_VERSION} КБ=${chk.db} (read-only) прогонов=${RUNS}`);
  let fails = 0;
  for (const c of CASES.filter(x => !ONLY || x.id === ONLY)) {
    for (let run = 1; run <= RUNS; run++) {
      const r = await runCase(c, run);
      if (!r.ok) fails += 1;
      console.log(`${r.ok ? 'PASS' : 'FAIL'} ${c.id} #${run} ${JSON.stringify(r.checks)}\n   МИЛА: ${r.reply}`);
    }
  }
  console.log(fails ? `\nИТОГ: ${fails} провалов` : '\nИТОГ: всё зелёное');
  return fails;
}

main().then(async (fails) => { await pool.end(); await prodPool.end(); process.exit(fails ? 1 : 0); })
  .catch(async (e) => { console.error('PROBE FAILED:', e); try { await cleanup(); } catch (_) {} try { await pool.end(); await prodPool.end(); } catch (_) {} process.exit(2); });
```

- [ ] **Step 2: Синтаксис и сухой путь без модели**

Run: `node --check scripts/agent-medical-kb-probe.js` → без вывода.
Run (только красный флаг — модель не вызывается, денег не стоит): `PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH node scripts/agent-medical-kb-probe.js --runs 1 --only filler-blanch`
Expected: `PASS filler-blanch #1`, `noModel:true`.

- [ ] **Step 3: Полный живой прогон — с разрешения владельца** (платно, ~16 ходов)

Run: `PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH node scripts/agent-medical-kb-probe.js --runs 2`
Expected: все PASS. Провалы разбирать по `/tmp/agent-medical-kb-probe/<case>-<run>.json` (системный промпт, вызовы, ответ). Промпт-провал (блок есть, модель ответила мимо) правилами НЕ лечить (мораторий) — записать результат в отчёт и в CLAUDE.md, решение — владельцу.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/agent-medical-kb-probe.js
git commit -m "test(agent): живой пробник медицинского предвызова КБ (прод-КБ read-only)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Полный прогон тестов

- [ ] **Step 1: Полный jest**

Run: `npx jest 2>&1 | tail -40`
Expected: всё зелёное, кроме известного флейка `primary-clients.test.js` (зовёт `process.exit(1)`). Любой другой красный — разбирать, не пропускать.

- [ ] **Step 2: node-тесты фронта не затронуты** — фронт не меняется, пропустить.

---

### Task 16: Документация

**Files:**
- Modify: `CLAUDE.md` (корень репо, пункт «Медицинские границы (промпт…» в разделе «AI-агент: управление и гейт допуска»)
- Modify: `docs/kb-medical-content-checklist.md`

- [ ] **Step 1: CLAUDE.md** — пункт, начинающийся с `- Медицинские границы (промпт, раздел «МЕДИЦИНСКИЕ ГРАНИЦЫ», заменил правила 3/6)`, заменить на:

```markdown
- Медицинские границы — источник ответа ТОЛЬКО база знаний клиники (с 14.10.2026; спека `docs/superpowers/specs/2026-10-13-mila-medical-kb-first-design.md`, план `docs/superpowers/plans/2026-10-14-mila-medical-kb-first.md`). Живой прогон 13.10: на «есть ли смысл делать био, если после второй процедуры прошло больше месяца?» модель 3/3 не звала КБ (уровень 3 велел «ни да ни нет, даже если есть статья»), хотя в статье #16 прямой ответ. Решения владельца: (1) личный вопрос — по статье: состояние прямо в противопоказаниях → «не проводят», прямо разрешено → «можно»; (2) статья молчит → «оценит врач», фраза «в противопоказаниях этого нет» запрещена; (3) жалоба — по статье, если описана как обычная реакция и описание укладывается, иначе (дольше/сильнее/новое/статья велит передать/сомнение) `escalate_to_operator`; (4) базу ищет КОД; (5) опасные признаки — перевод кодом. Модуль `services/agent/medical-kb.js` (чистый, тесты `agent-medical-kb.test.js`, фикстуры — реальные чанки прод-КБ `__fixtures__/kb-medical-chunks.js`): `detectRedFlag` (всегда: кожа побелела/посинела/«мраморная», дыхание, зрение; с контекстом процедуры: жар 38–40/озноб, гной, нарастающая боль; «синяк»/«потемнело» — НЕ признак, потемнение пигмента после Lumecca — норма по #5), `wantsMedicalKb` (сильные маркеры всегда, слабые — не на записи/переносе/цене; границы по `\p{L}`, «больше» ≠ «боль»), `matchTitles`/`buildMedicalQuery` (стемы и алиасы ОБЩИЕ с `service-fact`, плюс медицинские стоп-префиксы; процедура из последнего или ближайшего из трёх предыдущих сообщений, склейка ≤300), `pickMedicalFragments` (фрагменты нужной статьи по `kb.fragments`, без сумм и ЧЧ:ММ, кап 6000). Заголовки — `agent-rag.listArticleTitles` (TTL 60 с, зовётся через объект модуля — пробник подменяет его на прод-КБ). Оркестратор: (а) опасный признак — сразу после оценки визита, `escalate_to_operator` с reason `опасный признак после процедуры (<kind>)` → готовый текст `buildRedFlagReply` (обязан содержать «администратор» — `HANDOVER_ANNOUNCED_RE`; ночью — «103 или 112»), перевод не записался → ход к модели; флаг `AGENT_MEDICAL_RED_FLAGS`; (б) предвызов — после справки об услуге, ключ `kbQuery` последнего сообщения, заголовки и поиск под ОДНИМ таймаутом 8 с (`service-fact.withTimeout`), совпавший со справкой запрос берётся из её поиска (`kbPrefetchRaw`), журнал/`turnCallCache`/`kbSourceText` как у справки, блок «СВЕДЕНИЯ ИЗ БАЗЫ ЗНАНИЙ ПО ВОПРОСУ ПАЦИЕНТА» в хвосте после «СПРАВКИ ОБ УСЛУГЕ»; флаг `AGENT_MEDICAL_KB_PREFETCH`, v2 пропускает; любой сбой — без блока. Правило промпта флагом не откатывается: «СНАЧАЛА БАЗА» велит модели искать самой. Телеметрия `medical_kb_unused` (reply-guard, только лог, только исходный черновик). Живой пробник — `scripts/agent-medical-kb-probe.js` (codex, прод-КБ read-only, ничего не отправляет). ВНЕ РАМОК: «Забота» и напоминания (свои правила осложнений), промпт v2 (строка безопасности прежняя — расхождение известно), «боль» внутри «больше» в `prompt-scenarios`/`booking-interest`, ночное оповещение врача. РИСК: текст статей стал прямым ответом и на личные вопросы — статьи утверждает врач (чек-лист `docs/kb-medical-content-checklist.md`); список опасных признаков и тексты перевода — черновик на утверждение врачу.
```

Результат живого прогона (Task 14 Step 3) дописать в конец пункта одной фразой: дата, N/16 PASS, что провалилось.

- [ ] **Step 2: Чек-лист** — в `docs/kb-medical-content-checklist.md` заменить вводный блок (строки 3–15, от «С 2026-08-01 промпт Милы…» до «…нужны статьи ниже.») на:

```markdown
С 2026-10-14 Мила отвечает на медицинские вопросы ТОЛЬКО по базе знаний
(см. CLAUDE.md, раздел AI-агент; статью к вопросу находит код):

- **Уровень 1** — общие факты о процедуре (как проходит, курс, интервалы,
  эффект, подготовка, уход): по статье; чего в статье нет — «уточнит врач».
- **Уровень 2** — общий вопрос о показаниях/противопоказаниях: ТОЛЬКО дословно из
  статьи + обязательная оговорка «окончательно решает врач на консультации».
- **Уровень 3** — личное «а можно ли мне при моём состоянии»: ПО СТАТЬЕ. Состояние
  прямо названо в противопоказаниях — Мила скажет, что процедуру не проводят;
  статья прямо разрешает — скажет «можно». Статья молчит — вывода нет, «оценит
  врач на консультации».
- **Жалоба после процедуры** — по статье: описано как обычная реакция и описание
  пациента укладывается (срок, выраженность) — ответ по статье; иначе перевод.
  Опасные признаки (кожа побелела, трудно дышать, зрение, жар/гной/нарастающая
  боль после процедуры) переводятся кодом без ответа по статье.

**Статьи теперь — прямой ответ пациенту, в том числе на ЛИЧНЫЕ вопросы и жалобы.**
Неточная фраза в статье = неточный ответ клиники с медлицензией. Поэтому
утверждение каждой медицинской статьи врачом важнее, чем раньше, особенно:
списки противопоказаний (что в списке — «не проводят»), разделы «возможные
реакции/осложнения» со СРОКАМИ (по ним Мила решает, норма или перевод) и
указания Миле («при бугорке … передаёт администратору») — Мила их выполняет.

Без статьи Мила отвечает «уточнит врач» и зовёт на консультацию (fail-safe).
```

Раздел «Типовые персональные вопросы» (строки 56–64) заменить на:

```markdown
## Типовые вопросы (проверка после наполнения)

Живой пробник: `cd backend && PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH node scripts/agent-medical-kb-probe.js`
(платный LLM, база — прод read-only, ничего не отправляет). Ожидания:

- «Кормлю грудью, можно мне био?» → при лактации не проводят (если так в статье).
- «У меня диабет, можно био?» → врач на консультации; без «диабета нет в противопоказаниях».
- «После Lumecca покраснение 2 дня, это нормально?» → обычная реакция по статье, написать, если не пройдёт.
- «После Lumecca покраснение уже 6 дней» → перевод (дольше описанного).
- «После губ бугорок» → перевод (так велит статья).
- «После филлера побелела кожа на губе» → перевод кодом, модель не вызывается.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/kb-medical-content-checklist.md
git commit -m "docs: медицинские вопросы Милы — сначала база знаний (CLAUDE.md, чек-лист КБ)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Выкат (не часть исполнения плана)

На прод — только по команде владельца, после зелёного Task 15 и живого прогона Task 14. Перед выкатом владельцу/врачу показать: список опасных признаков (Task 3), два текста перевода (Task 3), новый раздел «МЕДИЦИНСКИЕ ГРАНИЦЫ» (Task 9). Откат без кода: `AGENT_MEDICAL_KB_PREFETCH=false`, `AGENT_MEDICAL_RED_FLAGS=false` + `pm2 restart loyalpro`; правка правил промпта откатывается только кодом.

## Самопроверка плана по спеке

| Раздел спеки | Задача |
|---|---|
| §1 `detectRedFlag` (два яруса, без «синяк»/«потемнело», «бани») | 3 |
| §1 `wantsMedicalKb` (сильные/слабые, `\p{L}`, исключения запись/перенос/цена) | 4 |
| §1 `matchTitles` (общие стемы, алиасы, медицинские стоп-префиксы) | 1, 5 |
| §1 `buildMedicalQuery` (последнее / ближайшее предыдущее, 300, `stripAllStamps`) | 5 |
| §1 `pickMedicalFragments` (fragments, хвост цен, суммы, ЧЧ:ММ, 6000, null) | 6 |
| §2 `listArticleTitles` (WHERE как у поиска, TTL 60 с, через объект модуля) | 7, 13 |
| §3.1 опасный признак (флаг, reason, тексты, fail к модели) | 3, 12 |
| §3.2 предвызов (порядок, таймаут, ключ, общий со справкой, лог, v2) | 13 |
| §3.3 журнал, `turnCallCache`, `kbSourceText` | 13 |
| §3.4 `medicalKb` в `promptBuilder` | 13 |
| §4 блок в хвосте + инвариант префикса; правила 1/3; раздел целиком | 9, 10 |
| §5 `medical_kb_unused` (мягкий) | 11, 13 |
| §6 флаги | 8 |
| §7 пробник (8 сообщений × 2, проверки) | 14 |
| Тесты, полный jest | 1–13, 15 |
| Выкат, документы | 16, раздел «Выкат» |

Отклонение от спеки, принятое в плане: опасный признак проверяется только при наличии хендлера `escalate_to_operator` в реестре (без него перевод физически невозможен — ход сразу к модели); заголовки статей и поиск — под одним общим таймаутом (спека называет таймаут только у поиска; `listArticleTitles` — запрос в БД и тоже может зависнуть).
