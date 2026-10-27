# Мила «как живой человек» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Убрать из реплик Милы то, что делает её «роботом» (markdown, скачущее обращение, приклеенное представление, казённые фразы кода), и перевести мост Codex на модель GPT-6 Astra на деве и проде.

**Architecture:** Чистый модуль `services/agent/reply-style.js` применяется в одной точке диспетчера и в воркере напоминаний; приветствие/представление получают двухстрочную форму в коде и в образцах промпта; фразы кода переписаны в стиле администраторов с «Вы» заглавной; идентификатор модели меняется в трёх константах, relay принимает старый и новый на время выката. Спека: `docs/superpowers/specs/2026-10-27-mila-human-tone-design.md`.

**Tech Stack:** Node.js 20 (`/root/.nvm/versions/node/v20.20.2/bin`), Jest (`npx jest <имя без .test.js>` из `backend/`), PostgreSQL через `pg`, Codex CLI 0.157.1 (подписка ChatGPT), systemd-сервис `mila-codex-bridge` на деве.

**Рабочее дерево:** worktree `/root/loyalpro/.worktrees/mila-human-tone`, ветка `feat/mila-human-tone` от `origin/main` (ba45f23, на нём прод). В `backend/` лежит скопированный `.env` (git-ignored, без него тесты падают на `JWT_SECRET`). Базовый прогон до правок: 23 набора, 1154 теста, все зелёные. Все команды ниже — из `backend/` этого worktree, с `export PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH`.

**Раскладка по моделям (решение владельца 27.10.2026):**

| Задача | Суть | Модель |
|---|---|---|
| 0 | Замер «до» на проде и реплей на Sol | ведущая сессия |
| 1 | Модель `gpt-6-astra`: константы, relay, реестр, тесты | Sonnet |
| 2 | Модуль `reply-style.js` + тесты | Opus |
| 3 | Проводка слоя: диспетчер, предложения, напоминания + тесты | Opus |
| 4 | Приветствие и представление: код, образцы промпта, тесты | Opus |
| 5 | Правила промпта: запрет markdown, эмодзи + тесты | Sonnet |
| 6 | Фразы кода и их тесты, placeholder на фронте | Sonnet |
| 7 | Скрипт замера `scripts/mila-style-metrics.js` + тест | Sonnet |
| 8 | Реплей на Astra, слияние, мост, дев, прод, проверка | ведущая сессия |

Порядок исполнения: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Задачи 1 и 5–7 не зависят от 2–4, но исполняются по очереди (решение владельца: без параллельных фоновых агентов).

**Файлы:**

- Создать: `backend/services/agent/reply-style.js`, `backend/reply-style.test.js`, `backend/scripts/mila-style-metrics.js`, `backend/mila-style-metrics.test.js`.
- Изменить: `backend/services/agent/providers/codex.js`, `backend/services/agent/providers/codex-relay-protocol.js`, `backend/services/agent/providers/codex-relay.js`, `backend/services/agent/model-routing.js`, `backend/services/agent/dispatcher.js`, `backend/services/agent/additional-proposals.js`, `backend/services/agent/followup-worker.js`, `backend/services/agent/greeting.js`, `backend/services/agent/system-prompt.js`, `backend/services/agent/admin-hours.js`, `backend/services/agent/phone-request.js`, `backend/services/agent/booking-interest.js`, `backend/services/agent/reply-guard.js`, `backend/services/agent/visit-rating.js`, `backend/services/agent/medical-kb.js`, `backend/services/agent/orchestrator.js`, `backend/services/agent/price-list.js`, `frontend/index.html`.
- Тесты изменить: `agent-provider-codex.test.js`, `agent-codex-relay.test.js`, `agent-model-routing.test.js`, `agent-dispatcher.test.js`, `agent-additional-proposals.test.js`, `agent-followup-worker.test.js`, `agent-greeting.test.js`, `agent-orchestrator.test.js`, `agent-system-prompt.test.js`, `agent-admin-hours.test.js`, `agent-visit-rating.test.js`, `agent-phone-request.test.js`, `agent-price-followthrough.test.js`.

---

### Task 0: Замер «до» и реплей на Sol (ведущая сессия)

Выполняется ДО задачи 1: после неё константа в worktree уже Astra, а сравнение нужно на одном и том же коде.

**Files:** ничего не меняет; отчёты в `/tmp`.

- [ ] **Step 1: Реплей девяти кейсов на Sol**

```bash
cd /root/loyalpro/.worktrees/mila-human-tone/backend
export PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH
echo 79200255591 | NODE_ENV=development MILA_CODEX_PROTOTYPE=true node scripts/mila-codex-full-prompt.js
cp /tmp/mila-codex-full-prompt-report.json /tmp/mila-tone-replay-sol.json
node -e "const r=require('/tmp/mila-tone-replay-sol.json');console.log(r.model);for(const c of r.cases)console.log(c.id,c.ms+'ms',c.error||'',(c.answer||'').slice(0,160).replace(/\n/g,' / '))"
```

Expected: `gpt-6-sol`, 9 строк с временем в мс и началом ответа. Скрипт только читает БД (`default_transaction_read_only=on`), write-инструменты застаблены, ничего не отправляет.

- [ ] **Step 2: Замер стиля «до» на проде (временным скриптом сессии)**

Скрипт `scripts/mila-style-metrics.js` появится в задаче 7; «до» снимается тем же SQL временным скриптом `/tmp/mila-style-patterns.js` из сессии 27.10 (он уже запускался: 116 реплик, markdown 28 %, заглавное «Вы» 55 %, представлений 23, приклеенных 22, серий 3+ 7). Если файла в `/tmp` нет — снять «до» задачей 7 сразу после её выполнения, до выката.

---

### Task 1: Модель GPT-6 Astra на мосту и в relay (Sonnet)

**Files:**
- Modify: `backend/services/agent/providers/codex.js:12`
- Modify: `backend/services/agent/providers/codex-relay-protocol.js:4-5,36`
- Modify: `backend/services/agent/providers/codex-relay.js:4-9,58-67`
- Modify: `backend/services/agent/model-routing.js:10-18`
- Test: `backend/agent-provider-codex.test.js:65`, `backend/agent-codex-relay.test.js`, `backend/agent-model-routing.test.js:89`

- [ ] **Step 1: Обновить тесты на новый идентификатор и допуск старого**

В `agent-provider-codex.test.js` строка 65:

```js
  expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'gpt-6-astra']);
```

В `agent-model-routing.test.js` строка 89 и ниже:

```js
  expect(status).toMatchObject({ active: 'gpt', model: 'gpt-6-astra', notice: null });
  expect(status.choices.find(c => c.id === 'gpt')).toMatchObject({ title: 'GPT-6 Astra', model: 'gpt-6-astra' });
```

В `agent-codex-relay.test.js` после теста `rejects mismatched response %s` добавить:

```js
// Мост и прод выкатываются не одновременно: в окне между выкатами ответ со
// старой моделью обязан проходить, иначе relay выбросил бы Милу на «Пользу».
test('previous GPT model in the bridge response is accepted and reported as is', async () => {
  await start();
  const fetchImpl = async (target, opts) => {
    const real = await fetch(target, opts); const data = await real.json(); data.model = 'gpt-6-sol';
    return new Response(JSON.stringify(data), { status: 200 });
  };
  await expect(provider({ fetchImpl }).createMessage(input)).resolves.toMatchObject({ text: 'Hello', model: 'gpt-6-sol' });
});
test('current GPT model is reported from the bridge response', async () => {
  await start();
  await expect(provider().createMessage(input)).resolves.toMatchObject({ text: 'Hello', model: 'gpt-6-astra' });
});
```

- [ ] **Step 2: Прогнать тесты — должны упасть**

Run: `npx jest agent-provider-codex agent-codex-relay agent-model-routing`
Expected: FAIL — `gpt-6-sol` вместо `gpt-6-astra` в трёх местах, `RELAY_RESPONSE` в новом тесте.

- [ ] **Step 3: Константы и допуск**

`codex.js` строка 12:

```js
const MODEL = 'gpt-6-astra';
```

`codex-relay-protocol.js` строки 4–5 и экспорт:

```js
const MODEL = 'gpt-6-astra';
// Модели, которые relay принимает в ответе моста для движка gpt: мост и прод
// выкатываются по очереди, и жёсткое равенство одной константе в окне между
// выкатами уводило бы Милу на «Пользу» (RELAY_RESPONSE → bridge_unavailable).
const GPT_MODELS = Object.freeze(['gpt-6-astra', 'gpt-6-sol']);
const CLAUDE_MODEL = 'claude-sonnet';
```

```js
module.exports = { MODEL, GPT_MODELS, CLAUDE_MODEL, MAX_BYTES, ROUTE, signature, authorized, validRequest, failure };
```

`codex-relay.js`: импорт и проверка ответа.

```js
const { MODEL, GPT_MODELS, CLAUDE_MODEL, MAX_BYTES, signature, validRequest, failure, ROUTE } = require('./codex-relay-protocol');
```

В `createProvider` после `const model = …`:

```js
  const accepted = engine === 'claude' ? [CLAUDE_MODEL] : GPT_MODELS;
```

Проверку ответа заменить:

```js
        if (!accepted.includes(result.model) || result.requestId !== id) throw failure('RELAY_RESPONSE');
```

Возврат — фактическая модель моста (её же `resilient.js` кладёт в `agent_model_routing.model`):

```js
        return { ...parsed, model: result.model };
```

`model-routing.js`: подписи и модель из констант протокола.

```js
'use strict';

const { MODEL: GPT_MODEL, CLAUDE_MODEL } = require('./providers/codex-relay-protocol');

const SELECTABLE = ['gpt', 'claude', 'polza'];
const MODEL_TITLES = { 'gpt-6-astra': 'GPT-6 Astra', 'gpt-6-sol': 'GPT-6 Sol' };
```

и в `choices`:

```js
    gpt: { title: MODEL_TITLES[GPT_MODEL] || GPT_MODEL, model: GPT_MODEL, channel: 'Мост dev · подписка ChatGPT' },
    claude: { title: 'Claude Sonnet', model: CLAUDE_MODEL, channel: 'Мост dev · подписка Claude Code' },
    polza: { title: 'Польза', model: config.POLZA_CHAT_MODEL, channel: 'API polza.ai' },
    anthropic: { title: 'Anthropic', channel: 'API Anthropic' },
    aitunnel: { title: 'AI Tunnel', channel: 'API AI Tunnel' },
    codex: { title: 'Codex (dev)', model: GPT_MODEL, channel: 'Локальная подписка ChatGPT' },
```

- [ ] **Step 4: Прогнать тесты — зелёные**

Run: `npx jest agent-provider-codex agent-codex-relay agent-model-routing dialog-verdicts`
Expected: PASS, все наборы.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/providers/codex.js backend/services/agent/providers/codex-relay-protocol.js backend/services/agent/providers/codex-relay.js backend/services/agent/model-routing.js backend/agent-provider-codex.test.js backend/agent-codex-relay.test.js backend/agent-model-routing.test.js
git commit -m "feat(agent): мост Codex — модель gpt-6-astra, relay принимает прежнюю на время выката"
```

---

### Task 2: Модуль `reply-style.js` (Opus)

**Files:**
- Create: `backend/services/agent/reply-style.js`
- Test: `backend/reply-style.test.js`

- [ ] **Step 1: Написать тесты**

```js
'use strict';

// Стилевой слой исходящих реплик Милы (спека 2026-10-27-mila-human-tone-design.md,
// раздел 4.1). Замер прода 27.10: markdown в 28 % реплик, «Вы» с заглавной в 55 %,
// «вы» со строчной в 13 % — TDLib-шлюз и MAX показывают звёздочки буквально.
const s = require('./services/agent/reply-style');

describe('stripMarkdown', () => {
  test('жирный и подчёркивание двойными маркерами', () => {
    expect(s.stripMarkdown('Есть **15:30** или __17:00__.')).toBe('Есть 15:30 или 17:00.');
  });
  test('одиночные маркеры курсива только вплотную к тексту', () => {
    expect(s.stripMarkdown('это *важно* и _срочно_')).toBe('это важно и срочно');
    expect(s.stripMarkdown('5*3=15, цена 2*500 ₽')).toBe('5*3=15, цена 2*500 ₽');
    expect(s.stripMarkdown('peri_clinic_promo')).toBe('peri_clinic_promo');
  });
  test('списки со звёздочкой и дефисом → «•», нумерованные не трогаем', () => {
    expect(s.stripMarkdown('Рекомендации:\n*   не загорать\n- не пить\n1. вода')).toBe('Рекомендации:\n• не загорать\n• не пить\n1. вода');
  });
  test('заголовки, обратные кавычки, ссылки', () => {
    expect(s.stripMarkdown('## Подготовка\nПриходите с `чистой кожей`')).toBe('Подготовка\nПриходите с чистой кожей');
    expect(s.stripMarkdown('Прайс: [на сайте](https://peri-clinic.ru/price)')).toBe('Прайс: на сайте: https://peri-clinic.ru/price');
  });
  test('пустые строки схлопываются до одной, хвостовые пробелы убираются', () => {
    expect(s.stripMarkdown('Да.  \n\n\n\nЗаписать?')).toBe('Да.\n\nЗаписать?');
  });
  test('не-строка → пустая строка', () => {
    expect(s.stripMarkdown(null)).toBe('');
    expect(s.stripMarkdown(undefined)).toBe('');
  });
});

describe('capitalizeAddress', () => {
  test('все формы обращения как отдельные слова', () => {
    expect(s.capitalizeAddress('у вас, к вам, с вами, ваш номер, ваша запись, в вашем случае'))
      .toBe('у Вас, к Вам, с Вами, Ваш номер, Ваша запись, в Вашем случае');
  });
  test('внутри слов не трогает', () => {
    expect(s.capitalizeAddress('выбрать время, вышлю, вашингтон')).toBe('выбрать время, вышлю, вашингтон');
  });
  test('уже заглавные не меняются', () => {
    expect(s.capitalizeAddress('Вы записаны, Ваш визит')).toBe('Вы записаны, Ваш визит');
  });
});

describe('applyReplyStyle', () => {
  test('markdown + обращение за один вызов, эмодзи и времена сохраняются', () => {
    expect(s.applyReplyStyle('Да, **15:30** свободно, записать вас? 🤍')).toBe('Да, 15:30 свободно, записать Вас? 🤍');
  });
  test('идемпотентна', () => {
    const once = s.applyReplyStyle('*   пункт с **жирным** и вашим временем 14:00');
    expect(s.applyReplyStyle(once)).toBe(once);
    expect(once).toBe('• пункт с жирным и Вашим временем 14:00');
  });
  test('рычаг AGENT_REPLY_STYLE=false выключает преобразования', () => {
    expect(s.applyReplyStyle('**x** вас', { env: { AGENT_REPLY_STYLE: 'false' } })).toBe('**x** вас');
    expect(s.isEnabled({ AGENT_REPLY_STYLE: 'false' })).toBe(false);
    expect(s.isEnabled({})).toBe(true);
  });
});
```

- [ ] **Step 2: Прогнать — падает на отсутствующем модуле**

Run: `npx jest reply-style`
Expected: FAIL — `Cannot find module './services/agent/reply-style'`.

- [ ] **Step 3: Реализация**

`backend/services/agent/reply-style.js`:

```js
'use strict';

// ── Стилевой слой исходящих реплик Милы ─────────────────────────────────────
// Чистый модуль: ни БД, ни HTTP. Применяется в ОДНОЙ точке диспетчера (обёртка
// send) и в воркере напоминаний о себе — спека
// docs/superpowers/specs/2026-10-27-mila-human-tone-design.md, раздел 4.
//
// ЗАЧЕМ: замер прода 27.10.2026 — markdown в 28 % реплик (`**15:30**`,
// `*   пункт`), а TDLib-шлюз шлёт formattedText с пустым entities и MAX —
// простой текст, то есть звёздочки видны буквально; обращение скачет между
// «Вы» модели (55 %) и «вы» фраз кода. Промпт при этом сам велел «жирным
// выделяй время». Правило одно и в коде: markdown убираем, обращение — с
// заглавной (решение владельца: «Вы» остаётся).

const ADDRESS_FORMS = ['вы', 'вас', 'вам', 'вами', 'ваш', 'ваша', 'ваше', 'ваши', 'вашу',
  'вашей', 'вашего', 'вашему', 'ваших', 'вашим', 'вашими', 'вашею'];
// Границы по буквам, а не \b: \b в JS считает словом только ASCII и на
// кириллице не срабатывает никогда (та же готча, что в address-guard).
const ADDRESS_RE = new RegExp(`(?<![\\p{L}])(?:${ADDRESS_FORMS.join('|')})(?![\\p{L}])`, 'gu');

function isEnabled(env = process.env) {
  return String((env && env.AGENT_REPLY_STYLE) || '').trim().toLowerCase() !== 'false';
}

function stripMarkdown(input) {
  let t = String(input == null ? '' : input);
  // Ссылка [текст](url) → «текст: url» — до остального, пока скобки целы.
  t = t.replace(/\[([^\]\n]+)\]\((\S+?)\)/g, '$1: $2');
  // Жирный/подчёркнутый двойными маркерами — внутри одной строки.
  t = t.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, '$1');
  t = t.replace(/__([^_\n][^_\n]*?)__/g, '$1');
  // Обратные кавычки вокруг текста.
  t = t.replace(/`([^`\n]+)`/g, '$1');
  // Заголовки и маркеры списков — только в начале строки. «•» и нумерация не трогаются.
  t = t.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  t = t.replace(/^[ \t]*[*\-+][ \t]+(?=\S)/gm, '• ');
  // Одиночные *курсив* / _курсив_: маркеры вплотную к тексту, снаружи не буква,
  // цифра и не «_» — так «5*3» и подчёркивания в адресах остаются как есть.
  t = t.replace(/(?<![\p{L}\p{N}_*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\p{L}\p{N}_*])/gu, '$1');
  t = t.replace(/(?<![\p{L}\p{N}_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, '$1');
  // Хвостовые пробелы и лишние пустые строки.
  t = t.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  return t;
}

function capitalizeAddress(input) {
  return String(input == null ? '' : input).replace(ADDRESS_RE, m => m[0].toUpperCase() + m.slice(1));
}

// Идемпотентна: f(f(x)) === f(x) — внутри диспетчера слой применяется дважды
// (список реплик и обёртка send), и это закреплено тестом.
function applyReplyStyle(text, opts = {}) {
  const raw = String(text == null ? '' : text);
  if (!isEnabled(opts.env)) return raw;
  return capitalizeAddress(stripMarkdown(raw));
}

module.exports = { stripMarkdown, capitalizeAddress, applyReplyStyle, isEnabled, ADDRESS_FORMS };
```

- [ ] **Step 4: Прогнать — зелёные**

Run: `npx jest reply-style`
Expected: PASS, 12 тестов.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/reply-style.js backend/reply-style.test.js
git commit -m "feat(agent): reply-style — markdown долой, обращение «Вы» с заглавной (чистый модуль)"
```

---

### Task 3: Проводка слоя в диспетчер, предложения и напоминания (Opus)

**Files:**
- Modify: `backend/services/agent/dispatcher.js:9-27,116-125,143-146`
- Modify: `backend/services/agent/additional-proposals.js:24-28`
- Modify: `backend/services/agent/followup-worker.js:22-41,~700`
- Test: `backend/agent-dispatcher.test.js`, `backend/agent-additional-proposals.test.js`, `backend/agent-followup-worker.test.js`

- [ ] **Step 1: Тесты**

В `agent-dispatcher.test.js` после теста `серия из двух сообщений в окне дебаунса → один прогон` добавить:

```js
// Стилевой слой (reply-style) стоит в обёртке send ПЕРВЫМ: журнал авторства
// хэширует отправленный текст, и эхо мессенджера принесёт именно его.
test('стилевой слой: markdown убран и «вы» с заглавной до отправки и журнала авторства', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: ['Да, **15:30** свободно, записать вас?'], escalated: false })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.send).toHaveBeenCalledWith(meta, 'Да, 15:30 свободно, записать Вас?');
  expect(d.authorship.remember).toHaveBeenCalledWith(1, 'k', 'Да, 15:30 свободно, записать Вас?', 'agent');
});
```

В `agent-additional-proposals.test.js` после теста `prepare uses verified catalog and slots without writing CRM` добавить (фикстуры `proposals`, `context()`, `input`, `nowMs` уже объявлены в шапке файла):

```js
// Стилевой слой (reply-style) применяется к реплике ДО отправки, а markSent
// проверяет includes(p.text): текст предложения обязан храниться в той же форме.
test('текст предложения хранится уже в финальном стиле — markSent сверяет его с отправленным', () => {
  const ctx = context();
  const p = proposals.prepare(1, ctx, input, 'Предлагаю **дополнительный визит**, вы согласны?');
  expect(p.text).toBe('Предлагаю дополнительный визит, Вы согласны?');
  expect(proposals.markSent(1, ctx.dialogKey, p.id, ['Конечно. Предлагаю дополнительный визит, Вы согласны?'], nowMs)).toBe(true);
});
```

В `agent-followup-worker.test.js` рядом с тестом `пустой шаблон салона → дефолтный текст`:

```js
  test('текст напоминания проходит стилевой слой: markdown убран, «вы» с заглавной', async () => {
    const d = deps();
    await worker.processOne(row({ stage: 1, followup_final_text: 'Если **вопросы** — пишите, я с вами' }), d);
    expect(d.calls.sent[0].text).toBe('Если вопросы — пишите, я с Вами');
  });
```

- [ ] **Step 2: Прогнать — падают**

Run: `npx jest agent-dispatcher agent-additional-proposals agent-followup-worker`
Expected: три новых теста FAIL (текст с `**` и строчным «вы»).

- [ ] **Step 3: Диспетчер**

`dispatcher.js`, импорты (после `const priceList = require('./price-list');`):

```js
const replyStyle = require('./reply-style');
```

Обёртка `send`:

```js
  const send = async (m, rawText) => {
    // Стилевой слой (reply-style) — ПЕРВЫМ: журнал авторства, pending-replies,
    // «Чат» и сторож доставки обязаны видеть ТОТ текст, что ушёл пациенту;
    // эхо мессенджера принесёт именно его.
    const text = replyStyle.applyReplyStyle(rawText);
    // Журнал авторства — ДО отправки: эхо шлюза может прийти раньше возврата
    // rawSend. Без await: доставка не ждёт служебной записи. remember не бросает.
    authorLog.remember(salonId, dialogKey, text, 'agent');
    const out = await rawSend(m, text);
    pendingReplies.remember(salonId, dialogKey, text);
    try { await persistOwn(salonId, dialogKey, m, text, out); }
    catch (e) { logger.warn(`dialog ${dialogKey}: своя реплика не легла в «Чат» (${e.message})`); }
    try { await deliveryLog.record(salonId, dialogKey, m, text, out); }
    catch (e) { logger.warn(`dialog ${dialogKey}: отправка не попала в журнал доставок (${e.message})`); }
    return out;
  };
```

`deliverReplies` — первая строка тела:

```js
  const deliverReplies = async (rawList, attachments, priceListUrl) => {
    // Слой применяется ДО цикла: в markSent обязан уйти тот же текст, что
    // отправлен (offered() сверяет deliveredText с транскриптом). Внутри send
    // слой повторится — он идемпотентен.
    const list = (rawList || []).map(t => replyStyle.applyReplyStyle(t));
    let acceptedAll = true;
```

Остальное тело `deliverReplies` без изменений (`list` дальше используется как раньше).

- [ ] **Step 4: Предложения дополнительного визита**

`additional-proposals.js`: импорт и `prepare`.

```js
const { applyReplyStyle } = require('./reply-style');
```

В `prepare` поле `text`:

```js
    text: applyReplyStyle(text), deliveredText: null, sentAt: null, expiresAt: (ctx.nowMs || Date.now()) + TTL_MS });
```

- [ ] **Step 5: Напоминания о себе**

`followup-worker.js`: импорт после строки 31 (`const replyGuard = require('./reply-guard');`):

```js
const replyStyle = require('./reply-style');
```

Перед блоком `// ── 8. Захват строки: последний гейт перед side-effect'ом ──`:

```js
    // Стилевой слой — тот же, что у реплик диспетчера (reply-style): в
    // rendered_text и в отправку уходит один и тот же текст.
    text = replyStyle.applyReplyStyle(text);
```

- [ ] **Step 6: Прогнать — зелёные, плюс смежные наборы**

Run: `npx jest agent-dispatcher agent-additional-proposals agent-followup-worker agent-window-handover agent-orchestrator`
Expected: PASS. Если в `agent-dispatcher.test.js` упало сравнение дословного текста с «вы» строчным или `**` — это ожидаемое следствие слоя: поправить ожидание на преобразованный текст (в базовой версии файла таких тестов нет: `'Здравствуйте!'`, `'Спасибо, что предупредили!'`, `'Готово! Записала Ирину…'` слой не меняет).

- [ ] **Step 7: Commit**

```bash
git add backend/services/agent/dispatcher.js backend/services/agent/additional-proposals.js backend/services/agent/followup-worker.js backend/agent-dispatcher.test.js backend/agent-additional-proposals.test.js backend/agent-followup-worker.test.js
git commit -m "feat(agent): стилевой слой в send диспетчера, предложениях доп. визита и напоминаниях о себе"
```

---

### Task 4: Приветствие и представление в две строки (Opus)

**Files:**
- Modify: `backend/services/agent/greeting.js:46-103`
- Modify: `backend/services/agent/system-prompt.js:195,210,216`
- Test: `backend/agent-greeting.test.js`, `backend/agent-orchestrator.test.js:959-961,2218-2220`, `backend/agent-system-prompt.test.js`

- [ ] **Step 1: Переписать ожидания в `agent-greeting.test.js`**

Блок `ensureGreeting`:

```js
describe('ensureGreeting', () => {
  const opts = { givenName: 'Юлия', salonName: 'PERI CLINIC' };

  test('приветствие в две строки дописывается В НАЧАЛО первой реплики', () => {
    const out = g.ensureGreeting(['Да, на 12 августа в 16:00 есть свободное время.'], opts);
    expect(out[0]).toBe(
      'Здравствуйте, Юлия!🤍\nЭто Мила, виртуальный администратор PERI CLINIC.\n\n'
      + 'Да, на 12 августа в 16:00 есть свободное время.');
  });

  // Сочувствие, извинение, перевод — без 🤍 в приветственной строке.
  test('эмпатичная реплика → приветствие без сердечка', () => {
    const out = g.ensureGreeting(['Мне жаль, что прокол гноится. Передаю Ваше сообщение администратору.'], opts);
    expect(out[0].split('\n')[0]).toBe('Здравствуйте, Юлия!');
  });

  test('приветствие уже есть → реплики не трогаем', () => {
    const replies = ['Здравствуйте, Юлия! Свободно 16:00'];
    expect(g.ensureGreeting(replies, opts)).toEqual(replies);
  });

  test('приветствие во второй реплике серии не дублируется', () => {
    const replies = ['Секунду, уточню', 'Здравствуйте! Свободно 16:00'];
    expect(g.ensureGreeting(replies, opts)).toEqual(replies);
  });

  test('имени не знаем → приветствие без имени', () => {
    expect(g.ensureGreeting(['Есть 16:00'], { salonName: 'PERI CLINIC' })[0])
      .toBe('Здравствуйте!🤍\nЭто Мила, виртуальный администратор PERI CLINIC.\n\nЕсть 16:00');
  });

  test('мусор вместо имени → обращение без имени', () => {
    expect(g.ensureGreeting(['Есть 16:00'], { givenName: '79001112233', salonName: 'PERI CLINIC' })[0])
      .toMatch(/^Здравствуйте!🤍\nЭто Мила/);
  });

  test('салон не передан → тот же дефолт, что у промпта', () => {
    const { resolveSalonName } = require('./services/agent/system-prompt');
    expect(g.ensureGreeting(['Есть 16:00'], {})[0])
      .toBe(`Здравствуйте!🤍\nЭто Мила, виртуальный администратор ${resolveSalonName()}.\n\nЕсть 16:00`);
    expect(resolveSalonName()).toBe('PERI CLINIC');
  });

  test('пустой список реплик не трогаем', () => {
    expect(g.ensureGreeting([], opts)).toEqual([]);
  });
});
```

Блок связи с промптом:

```js
describe('связь с образцом первого сообщения в промпте', () => {
  test('представление дословно совпадает с формулировкой промпта', () => {
    const { buildSystemPrompt } = require('./services/agent/system-prompt');
    const p = buildSystemPrompt({ salonName: 'PERI CLINIC', clientName: 'Юлия', phoneKnown: true });
    expect(p).toContain('Здравствуйте, Юлия!🤍\nЭто Мила, виртуальный администратор PERI CLINIC.');
    expect(g.buildGreeting({ givenName: 'Юлия', salonName: 'PERI CLINIC' }))
      .toBe('Здравствуйте, Юлия!🤍\nЭто Мила, виртуальный администратор PERI CLINIC.');
  });
});
```

Блок `hasIntroduction` — добавить формы:

```js
  test('узнаёт представление в реплике модели', () => {
    expect(g.hasIntroduction('Здравствуйте! Я Мила, виртуальный администратор PERI CLINIC.')).toBe(true);
    expect(g.hasIntroduction('Здравствуйте!\nЭто Мила, виртуальный администратор PERI CLINIC.')).toBe(true);
    expect(g.hasIntroduction('На связи Мила.')).toBe(true);
    expect(g.hasIntroduction('меня зовут Мила')).toBe(true);
  });
```

Блок `ensureIntroduction`:

```js
describe('ensureIntroduction', () => {
  const opts = { salonName: 'PERI CLINIC' };

  test('представление встаёт отдельной строкой СРАЗУ ПОСЛЕ приветствия, суть — после пустой строки', () => {
    const out = g.ensureIntroduction(['Здравствуйте, Марина! 👋\n\nДа, конечно, сейчас проверю.'], opts);
    expect(out[0]).toBe(
      'Здравствуйте, Марина! 👋\nЭто Мила, виртуальный администратор PERI CLINIC.\n\nДа, конечно, сейчас проверю.');
  });

  test('приветствие и текст разделены пробелом → текст уходит на новый абзац', () => {
    const out = g.ensureIntroduction(
      ['Татьяна, здравствуйте! Понимаю, хотите убедиться, что всё делаете правильно. 🤍'], opts);
    expect(out[0]).toBe(
      'Татьяна, здравствуйте!\nЭто Мила, виртуальный администратор PERI CLINIC.\n\n'
      + 'Понимаю, хотите убедиться, что всё делаете правильно. 🤍');
  });

  test('приветствия в реплике нет → представление уходит в начало', () => {
    const out = g.ensureIntroduction(['Рекомендации по массажу даст врач.'], opts);
    expect(out[0]).toBe('Это Мила, виртуальный администратор PERI CLINIC.\n\nРекомендации по массажу даст врач.');
  });

  test('модель представилась сама (любая форма) → ничего не дописываем', () => {
    for (const reply of ['Здравствуйте! Я Мила, виртуальный администратор PERI CLINIC. Чем помочь?',
      'Здравствуйте!🤍\nЭто Мила, виртуальный администратор PERI CLINIC.\n\nЧем помочь?']) {
      expect(g.ensureIntroduction([reply], opts)).toEqual([reply]);
    }
  });

  test('представление во второй реплике серии считается', () => {
    const list = ['Секунду.', 'Это Мила, виртуальный администратор PERI CLINIC.'];
    expect(g.ensureIntroduction(list, opts)).toEqual(list);
  });

  test('пустая серия остаётся пустой', () => {
    expect(g.ensureIntroduction([], opts)).toEqual([]);
  });

  test('после ensureGreeting представление уже есть и не задваивается', () => {
    const once = g.ensureGreeting(['Свободно в 16:00.'], { givenName: 'Юлия', salonName: 'PERI CLINIC' });
    expect(g.ensureIntroduction(once, opts)).toEqual(once);
  });
});
```

Комментарии-шапки блоков (про инциденты) оставить как есть.

- [ ] **Step 2: Обновить ожидания оркестратора и промпта**

`agent-orchestrator.test.js` строки 959–961:

```js
    expect(out.replies[0]).toBe(
      'Здравствуйте, Юлия!🤍\nЭто Мила, виртуальный администратор PERI CLINIC.\n\n'
      + 'К сожалению, 16:00 занято — есть 18:30.');
```

строки 2218–2220:

```js
    expect(out.replies).toEqual([
      'Здравствуйте, Марина! 👋\nЭто Мила, виртуальный администратор PERI CLINIC.\n\nСейчас проверю.',
    ]);
```

`agent-system-prompt.test.js`, тест `образец приветствия и запрет тавтологии` (строка ~351) дополнить:

```js
  test('образец приветствия и запрет тавтологии', () => {
    const p = buildSystemPrompt({ salonName: 'PERI CLINIC' });
    expect(p).toContain('виртуальный администратор PERI CLINIC');
    expect(p).toContain('Здравствуйте!🤍\nЭто Мила, виртуальный администратор PERI CLINIC.\n\nПодскажите, как могу к Вам обращаться');
    expect(p).not.toContain('Я Мила, виртуальный администратор');
    expect(p).toMatch(/тавтолог/i);
  });
```

- [ ] **Step 3: Прогнать — падают**

Run: `npx jest agent-greeting agent-orchestrator agent-system-prompt`
Expected: FAIL на новых формах.

- [ ] **Step 4: `greeting.js`**

Заменить `INTRO_RE`, `buildIntroduction`, `ensureIntroduction`, `buildGreeting`, `ensureGreeting` (комментарии над ними оставить, дописав ЗАЧЕМ новой формы):

```js
// Обе формы: старая «Я Мила…» (транскрипты до 27.10.2026 и реплики модели по
// памяти) и новая «Это Мила…» — иначе представление задвоилось бы.
const INTRO_RE = /(я\s+Мила|это\s+Мила|на\s+связи\s+Мила|меня\s+зовут\s+Мила|виртуальн[а-яё]+\s+администратор)/i;

// Сочувствие, извинение, перевод на администратора — без 🤍 в приветственной
// строке: сердечко перед «мне жаль, что прокол гноится» читалось бы издёвкой.
const EMPATHY_RE = /(жаль|сочувств|извин|простите|прошу прощения|передаю)/i;
```

```js
function buildIntroduction(opts = {}) {
  return `Это Мила, виртуальный администратор ${resolveSalonName(opts.salonName)}.`;
}

// Дописывает представление, если его нет ВО ВСЕЙ серии реплик. Форма с
// 27.10.2026 (решение владельца, ориентир — живые администраторы): приветствие
// отдельной строкой, представление — следующей, суть — после пустой строки.
function ensureIntroduction(replies, opts = {}) {
  const list = Array.isArray(replies) ? replies : [];
  if (!list.length) return list;
  if (list.some(hasIntroduction)) return list;
  const out = list.slice();
  const intro = buildIntroduction(opts);
  const lead = out[0].match(LEADING_GREETING_RE);
  out[0] = lead
    ? `${lead[0].trimEnd()}\n${intro}\n\n${out[0].slice(lead[0].length).replace(/^\s+/, '')}`
    : `${intro}\n\n${out[0]}`;
  return out;
}

function buildGreeting(opts = {}) {
  // Имя приходит из карточки YClients — единственное клиент-контролируемое
  // значение здесь. Фильтр тот же, что у промпта: телефон и «Тест 2» вместо
  // имени (11.6% боевых карточек PERI) → обращение без имени.
  const name = sanitizeName(opts.givenName);
  // Название клиники — через общий с промптом резолвер (в runDialog salonName
  // не передаёт никто, промпт живёт на дефолте).
  const salon = resolveSalonName(opts.salonName);
  const heart = opts.empathetic ? '' : '🤍';
  return `Здравствуйте${name ? `, ${name}` : ''}!${heart}\nЭто Мила, виртуальный администратор ${salon}.`;
}

// Дописывает приветствие в НАЧАЛО первой реплики, если во всей серии его нет.
// Серия уходит пациенту отдельными сообщениями, поэтому проверяется вся: своё
// приветствие во второй реплике — тоже приветствие, дублировать его нельзя.
function ensureGreeting(replies, opts = {}) {
  const list = Array.isArray(replies) ? replies : [];
  if (!list.length) return list;
  if (list.some(hasGreeting)) return list;
  const out = list.slice();
  const empathetic = opts.empathetic != null ? !!opts.empathetic : EMPATHY_RE.test(list.join('\n'));
  out[0] = `${buildGreeting({ ...opts, empathetic })}\n\n${out[0]}`;
  return out;
}

module.exports = {
  hasGreeting, buildGreeting, ensureGreeting,
  hasIntroduction, buildIntroduction, ensureIntroduction, EMPATHY_RE,
};
```

- [ ] **Step 5: Образцы в промпте**

`system-prompt.js` строка 195:

```js
    `- Образец ПЕРВОГО сообщения (приветствие — первой строкой, представление — второй, суть — после пустой строки): «Здравствуйте, ${clientName}!🤍\nЭто Мила, виртуальный администратор ${salonName}.\n\nЧем могу помочь?»`,
```

строки 210 и 216 (одинаковые):

```js
    `- Образец ПЕРВОГО сообщения (приветствие — первой строкой, представление — второй, имя и цель — после пустой строки, одним сообщением, больше вопросов не задавай): «Здравствуйте!🤍\nЭто Мила, виртуальный администратор ${salonName}.\n\nПодскажите, как могу к Вам обращаться и на какую процедуру хотели бы записаться?»`,
```

- [ ] **Step 6: Прогнать — зелёные**

Run: `npx jest agent-greeting agent-orchestrator agent-system-prompt agent-reply-guard agent-address-guard`
Expected: PASS. Если `agent-system-prompt.test.js` где-то ещё ждёт `👋` или «Я Мила» в образце — поправить ожидание на новую форму (другие проверки образца в базовой версии файла: только строка 353 и регэксп в тесте «ветка известного пациента требует поздороваться»).

- [ ] **Step 7: Commit**

```bash
git add backend/services/agent/greeting.js backend/services/agent/system-prompt.js backend/agent-greeting.test.js backend/agent-orchestrator.test.js backend/agent-system-prompt.test.js
git commit -m "feat(agent): приветствие и представление в две строки — код и образцы промпта"
```

---

### Task 5: Правила промпта: запрет markdown, эмодзи администраторов (Sonnet)

**Files:**
- Modify: `backend/services/agent/system-prompt.js:236,239`
- Test: `backend/agent-system-prompt.test.js`

- [ ] **Step 1: Тест**

В `agent-system-prompt.test.js` рядом с тестом `не анонсирует действия …` (строка ~378):

```js
  // 27.10.2026: TDLib-шлюз и MAX показывают markdown буквально, а правило само
  // велело «жирным выделяй время» — правка существующего правила, не новое.
  test('тон: без markdown-разметки и с эмодзи администраторов', () => {
    const p = buildSystemPrompt({ salonName: 'PERI CLINIC' });
    expect(p).not.toMatch(/жирным выделяй/);
    expect(p).toMatch(/без markdown-разметки/i);
    expect(p).toContain('(🤍, ✨)');
    expect(p).not.toContain('(🌸, 🤍, ✨, 🌿)');
  });
```

- [ ] **Step 2: Прогнать — падает**

Run: `npx jest agent-system-prompt -t "без markdown"`
Expected: FAIL.

- [ ] **Step 3: Правки строк 236 и 239**

```js
    `- Используй умеренное количество нейтральных эмодзи (🤍, ✨) — 0–1 на сообщение и НЕ в каждом: живой администратор ставит смайлик не чаще, чем в каждом втором-третьем сообщении, и не в одном и том же месте (не заканчивай каждое сообщение смайликом).`,
```

```js
    `- Максимальная лаконичность — пациенты ценят своё время. Убери восторженные вводные («Отлично!», «Прекрасно!», «Всё отлично!», «Время подходит идеально!») — сразу выдавай суть. В организационных сообщениях (варианты времени, подтверждение записи) не перегружай текст визуально: без markdown-разметки (жирный, звёздочки, списки со звёздочками) — мессенджеры показывают эти символы как есть; эмодзи — не больше одного на ответ, а лучше вовсе без него.`,
```

- [ ] **Step 4: Прогнать — зелёные**

Run: `npx jest agent-system-prompt agent-greeting`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js
git commit -m "fix(agent): промпт — без markdown-разметки, эмодзи как у администраторов"
```

---

### Task 6: Фразы кода в стиле администраторов (Sonnet)

**Files:**
- Modify: `backend/services/agent/admin-hours.js:48-58`
- Modify: `backend/services/agent/phone-request.js:59-64`
- Modify: `backend/services/agent/booking-interest.js:12`
- Modify: `backend/services/agent/reply-guard.js:591-592`
- Modify: `backend/services/agent/visit-rating.js:89-94`
- Modify: `backend/services/agent/medical-kb.js:102-107`
- Modify: `backend/services/agent/orchestrator.js:380-388`
- Modify: `backend/services/agent/price-list.js:144-148`
- Modify: `backend/services/agent/followup-worker.js:94-95`
- Modify: `frontend/index.html:1749`
- Test: `backend/agent-admin-hours.test.js:32-43`, `backend/agent-visit-rating.test.js:112-115`, `backend/agent-phone-request.test.js:34-36`, `backend/agent-followup-worker.test.js:909`, `backend/agent-price-followthrough.test.js:193,201`, `backend/agent-dispatcher.test.js:1035`

- [ ] **Step 1: Обновить тесты**

`agent-admin-hours.test.js`, блок `фразы эскалации` целиком:

```js
  describe('фразы эскалации', () => {
    test('в рабочее время — «с минуты на минуту»', () => {
      expect(ah.handoverText(false)).toBe(
        'Передаю Ваш вопрос администратору, он подключится с минуты на минуту 🤍');
      expect(ah.silentFallbackText(false)).toMatch(/с минуты на минуту/);
    });
    test('вне рабочего времени — без обещания немедленного ответа', () => {
      expect(ah.handoverText(true)).not.toMatch(/с минуты на минуту/);
      expect(ah.handoverText(true)).toMatch(/с утра/);
      expect(ah.silentFallbackText(true)).not.toMatch(/с минуты на минуту/);
      expect(ah.silentFallbackText(true)).toMatch(/с утра/);
    });
    // Стиль администраторов (27.10.2026): «Вы» с заглавной, перевод объявлен
    // общим признаком — иначе диспетчер дошлёт вторую фразу.
    test('все четыре фразы объявляют перевод и обращаются на «Вы» с заглавной', () => {
      for (const t of [ah.handoverText(false), ah.handoverText(true), ah.silentFallbackText(false), ah.silentFallbackText(true)]) {
        expect(t).toMatch(ah.HANDOVER_ANNOUNCED_RE);
        expect(t).not.toMatch(/(?<![\p{L}])(вы|вас|вам|ваш)(?![\p{L}])/u);
      }
    });
  });
```

`agent-visit-rating.test.js` строки 112–115:

```js
  test('ночью не обещаем скорый ответ — как handoverText в admin-hours', () => {
    expect(buildApology({ adminOff: true })).toMatch(/с утра/);
    expect(buildApology({ adminOff: false })).not.toMatch(/с утра/);
  });
```

`agent-phone-request.test.js` строки 34–36 (регэксп с `\b` на кириллице не срабатывал никогда — тест был пустым):

```js
  test('«ваш» в тексте нет: на канале без номера тот же текст уходит и при записи гостя', () => {
    expect(buildPhoneRequest({})).not.toMatch(/(?<![\p{L}])ваш/iu);
  });
```

`agent-followup-worker.test.js` строка 909:

```js
    expect(d.calls.sent[0].text).toBe('Подобрать Вам удобное окошко?');
```

`agent-price-followthrough.test.js` строки 193 и 201 — заменить `'Подобрать Вам удобное время для записи?'` на `'Подобрать Вам удобное окошко?'` (в обоих местах).

`agent-dispatcher.test.js` строка 1035:

```js
    expect(d.send.mock.calls[0][1]).toMatch(/Передаю Ваш вопрос администратору/);
```

- [ ] **Step 2: Прогнать — падают**

Run: `npx jest agent-admin-hours agent-visit-rating agent-phone-request agent-followup-worker agent-price-followthrough agent-dispatcher`
Expected: FAIL на новых текстах.

- [ ] **Step 3: Константы**

`admin-hours.js`:

```js
// Детерминированная страховка диспетчера: модель эскалировала, не объявив перевод.
// Стиль администраторов (27.10.2026): коротко, «Вы» с заглавной, 🤍.
function handoverText(offHours) {
  return offHours
    ? 'Передаю Ваш вопрос администратору. Сейчас нерабочее время, он ответит Вам с утра 🤍'
    : 'Передаю Ваш вопрос администратору, он подключится с минуты на минуту 🤍';
}

// Страховка инварианта «агент никогда не молчит» (ход без реплик / сбой).
// Диалог тут уже переведён на человека, поэтому не «уточню и вернусь»:
// отвечает администратор.
function silentFallbackText(offHours) {
  return offHours
    ? 'Передаю Ваш вопрос администратору, он ответит Вам с утра 🤍'
    : 'Секунду, передаю Ваш вопрос администратору, он ответит Вам с минуты на минуту 🤍';
}
```

`phone-request.js` (без «Ваш»: тот же текст уходит при записи гостя на чужой номер):

```js
function buildPhoneRequest({ datetime, allowedTimes } = {}) {
  const slot = datetime ? formatSlotMoscow(datetime) : null;
  const timeOk = slot && allowedTimes && typeof allowedTimes.has === 'function' && allowedTimes.has(slot.time);
  const what = timeOk ? `${slot.date} в ${slot.time}` : 'это время';
  return `Чтобы закрепить ${what}, напишите, пожалуйста, номер телефона 🤍`;
}
```

`booking-interest.js` строка 12:

```js
const STEP_QUESTION = 'Подобрать Вам удобное окошко?';
```

`reply-guard.js` строки 591–592:

```js
const SAFE_FALLBACK_TEXT = 'Понимаю Вас. Напишите, какой день и половина дня Вам удобнее, '
  + 'и я посмотрю свободные окошки.';
```

`visit-rating.js`:

```js
function buildApology(opts = {}) {
  const tail = opts.adminOff
    ? 'Передаю Ваш отзыв администратору, он свяжется с Вами с утра.'
    : 'Передаю Ваш отзыв администратору, он свяжется с Вами лично, чтобы разобраться.';
  return `Нам очень жаль, что визит Вас расстроил, простите нас, пожалуйста. ${tail}`;
}
```

`medical-kb.js`:

```js
function buildRedFlagReply(opts = {}) {
  const head = 'Мне очень жаль, что Вы с этим столкнулись.';
  return opts.adminOff
    ? `${head} Передаю Ваше сообщение администратору. Сейчас нерабочее время, он увидит его с утра. Если становится хуже, не ждите: звоните 103 или 112.`
    : `${head} Срочно передаю Ваше сообщение администратору, чтобы с Вами как можно скорее связался врач.`;
}
```

`orchestrator.js` `buildWriteConfirmation`:

```js
function buildWriteConfirmation(lastWrite) {
  const input = (lastWrite && lastWrite.input) || {};
  const who = String(input.client_name || '').trim() || 'Вас';
  if (lastWrite && lastWrite.tool === 'create_booking' && input.datetime) {
    const slot = formatSlotMoscow(input.datetime);
    if (slot) return `Записала ${who} на ${slot.date} в ${slot.time}, будем ждать 🤍`;
  }
  return 'Готово, всё оформила 🤍';
}
```

`price-list.js`:

```js
function photoFailureText(url) {
  const link = String(url || '').trim();
  const tail = link ? ` Полный прайс есть на сайте: ${link}.` : '';
  return `Простите, фото прайса не отправилось.${tail} Напишите, какая процедура Вас интересует, и я подскажу стоимость.`;
}
```

`followup-worker.js` строки 94–95:

```js
const DEFAULT_FINAL_TEXT = 'Если появятся вопросы, пишите, я на связи 🤍';
```

`frontend/index.html` строка 1749 (только атрибут `placeholder`; `index.html` отдаётся `no-store`, бамп `?v=` не нужен):

```html
              <textarea id="agent-followup-text" rows="3" placeholder="Например: Если у Вас остались вопросы, просто напишите, буду рада помочь 🤍 (пусто — стандартный текст: «Если появятся вопросы, пишите, я на связи 🤍»)"></textarea>
```

- [ ] **Step 4: Прогнать — зелёные, плюс смежные**

Run: `npx jest agent-admin-hours agent-visit-rating agent-phone-request agent-followup-worker agent-price-followthrough agent-dispatcher agent-booking-interest agent-medical-kb agent-reply-guard agent-price-list agent-orchestrator agent-history agent-window-handover`
Expected: PASS. Если в `agent-orchestrator.test.js` упало сравнение с `Готово! Записала` или `Будем ждать` — поправить ожидание на новую фразу `Записала … на … в …, будем ждать 🤍` (в базовой версии файла дословных сравнений с этой фразой нет).

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/admin-hours.js backend/services/agent/phone-request.js backend/services/agent/booking-interest.js backend/services/agent/reply-guard.js backend/services/agent/visit-rating.js backend/services/agent/medical-kb.js backend/services/agent/orchestrator.js backend/services/agent/price-list.js backend/services/agent/followup-worker.js frontend/index.html backend/agent-admin-hours.test.js backend/agent-visit-rating.test.js backend/agent-phone-request.test.js backend/agent-followup-worker.test.js backend/agent-price-followthrough.test.js backend/agent-dispatcher.test.js
git commit -m "feat(agent): фразы кода в стиле администраторов — «Вы» с заглавной, без канцелярита"
```

---

### Task 7: Скрипт замера стиля (Sonnet)

**Files:**
- Create: `backend/scripts/mila-style-metrics.js`
- Test: `backend/mila-style-metrics.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';

const { computeStyleMetrics } = require('./scripts/mila-style-metrics');

// Счётчики те же, что в разборе 27.10.2026 (спека …-mila-human-tone-design.md,
// раздел 6): сравнивать «до» и «после» одним инструментом.
test('счётчики стиля по синтетическим строкам', () => {
  const rows = [
    { key: 'a', direction: 'incoming', authored_by: null, text: 'Здравствуйте', msg_ts: 1 },
    { key: 'a', direction: 'outgoing', authored_by: 'agent', text: 'Здравствуйте, Полина! Я Мила, виртуальный администратор PERI CLINIC. Спасибо, что подтвердили визит.', msg_ts: 2 },
    { key: 'a', direction: 'outgoing', authored_by: 'agent', text: 'Есть **15:30**, записать вас?', msg_ts: 3 },
    { key: 'a', direction: 'outgoing', authored_by: 'agent', text: 'Если появятся вопросы, пишите 🤍', msg_ts: 4 },
    { key: 'b', direction: 'outgoing', authored_by: 'agent', text: 'Здравствуйте!\nЭто Мила, виртуальный администратор PERI CLINIC.\n\nЧем могу помочь?', msg_ts: 5 },
    { key: 'b', direction: 'outgoing', authored_by: 'system', text: 'Вы записаны', msg_ts: 6 },
  ];
  const m = computeStyleMetrics(rows);
  expect(m).toMatchObject({ replies: 4, dialogs: 2, intros: 2, introsStapled: 1, runs2: 0, runs3plus: 1 });
  expect(m.markdownPct).toBe(25);
  expect(m.lowerAddressPct).toBe(25);
  expect(m.capitalAddressPct).toBe(0);
  expect(m.emojiPct).toBe(25);
  expect(m.endsWithQuestionPct).toBe(50);
  expect(m.medianChars).toBeGreaterThan(0);
});

test('пустой набор не делит на ноль', () => {
  expect(computeStyleMetrics([])).toMatchObject({ replies: 0, dialogs: 0, markdownPct: 0, medianChars: 0 });
});
```

- [ ] **Step 2: Прогнать — падает**

Run: `npx jest mila-style-metrics`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Скрипт**

`backend/scripts/mila-style-metrics.js`:

```js
#!/usr/bin/env node
'use strict';
// Замер «роботского» стиля Милы — те же счётчики, что в разборе 27.10.2026
// (спека docs/superpowers/specs/2026-10-27-mila-human-tone-design.md, раздел 6):
// доля markdown, обращение с заглавной/строчной, представления и из них
// приклеенные к ответу по делу, эмодзи, вопрос в конце, серии реплик подряд
// без ответа пациента. Снимать до выката и через неделю после — одним инструментом.
//
//   node scripts/mila-style-metrics.js [--days=14] [--salon=1] [--db=loyalpro]
//
// Только чтение. --db подменяет имя БД в DATABASE_URL: с дева через туннель
// так читается прод-БД `loyalpro` (дев — `loyalpro_test`).
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const INTRO_RE = /(я\s+Мила|это\s+Мила|на\s+связи\s+Мила|виртуальн[а-яё]+\s+администратор)/i;
const MD_RE = /\*\*|^\s*[*\-]\s+\S|#{1,3}\s/m;
const CAP_RE = /(?<![\p{L}])(Вы|Вас|Вам|Вами|Ваш[а-яё]*)(?![\p{L}])/u;
const LOW_RE = /(?<![\p{L}])(вы|вас|вам|вами|ваш[а-яё]*)(?![\p{L}])/u;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
// «Чистое» приветствие: приветствие + представление (+ дежурный вопрос) и ничего
// больше; всё остальное с представлением — приклеено к ответу по делу.
const PURE_GREETING_RE = /^Здравствуйте[^\n]*\n?(?:Это|Я) Мила, виртуальный администратор[^.\n]*\.\s*(?:Подскажите, чем могу помочь\?|Чем могу помочь\?|Подскажите, как могу к Вам обращаться[^\n]*)?\s*$/i;

function median(values) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// rows: [{ key, direction, authored_by, text, msg_ts }] в хронологическом порядке
// внутри ключа диалога. Чистая функция — покрыта mila-style-metrics.test.js.
function computeStyleMetrics(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const agent = all.filter(r => r.direction === 'outgoing' && r.authored_by === 'agent' && r.text && String(r.text).trim());
  const n = agent.length;
  const pct = k => (n ? Math.round(100 * k / n) : 0);
  const lens = agent.map(r => String(r.text).length);
  const count = re => agent.filter(r => re.test(String(r.text))).length;
  const intros = agent.filter(r => INTRO_RE.test(String(r.text)));
  const introsStapled = intros.filter(r => !PURE_GREETING_RE.test(String(r.text).trim())).length;
  // Серии реплик Милы подряд: любое чужое сообщение (пациент, администратор,
  // автоуведомление) серию обрывает.
  let cur = null; const runs = [];
  for (const m of all) {
    const isAgent = m.direction === 'outgoing' && m.authored_by === 'agent';
    if (isAgent) {
      if (cur && cur.key === m.key) cur.n++;
      else { cur = { key: m.key, n: 1 }; runs.push(cur); }
    } else cur = null;
  }
  return {
    replies: n,
    dialogs: new Set(agent.map(r => r.key)).size,
    avgChars: n ? Math.round(lens.reduce((a, b) => a + b, 0) / n) : 0,
    medianChars: median(lens),
    markdownPct: pct(count(MD_RE)),
    capitalAddressPct: pct(count(CAP_RE)),
    lowerAddressPct: pct(count(LOW_RE)),
    intros: intros.length,
    introsStapled,
    emojiPct: pct(count(EMOJI_RE)),
    endsWithQuestionPct: pct(count(/\?\s*$/)),
    runs2: runs.filter(r => r.n === 2).length,
    runs3plus: runs.filter(r => r.n >= 3).length,
  };
}

const SQL = `
  SELECT coalesce(phone, chat_id) AS key, direction, authored_by, text, msg_ts
    FROM chatpush_messages
   WHERE salon_id = $1
     AND msg_ts >= extract(epoch from now() - ($2::int || ' days')::interval)
     AND (direction = 'incoming' OR authored_by IN ('agent', 'operator', 'system'))
   ORDER BY coalesce(phone, chat_id), msg_ts`;

async function main() {
  const { Client } = require('pg');
  const args = process.argv.slice(2);
  const opt = (name, def) => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
  const days = Number(opt('days', 14));
  const salon = Number(opt('salon', 1));
  const dbName = opt('db', null);
  if (!Number.isInteger(days) || days < 1 || days > 365 || !Number.isInteger(salon)) {
    console.error('usage: node scripts/mila-style-metrics.js [--days=14] [--salon=1] [--db=loyalpro]');
    process.exit(2);
  }
  let url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL не задан'); process.exit(2); }
  if (dbName) url = url.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(SQL, [salon, days]);
    const m = computeStyleMetrics(rows);
    console.log(JSON.stringify({ db: dbName || 'default', salon, days, ...m }, null, 2));
  } finally {
    await client.end();
  }
}

module.exports = { computeStyleMetrics, INTRO_RE, PURE_GREETING_RE };
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 4: Прогнать — зелёные, затем живой запуск на деве**

Run: `npx jest mila-style-metrics`
Expected: PASS, 2 теста.

Run: `node scripts/mila-style-metrics.js --days=14`
Expected: JSON с полями `replies`, `markdownPct`, … по дев-БД (числа любые, без ошибок).

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/mila-style-metrics.js backend/mila-style-metrics.test.js
git commit -m "feat(agent): scripts/mila-style-metrics — замер стиля реплик Милы до и после"
```

---

### Task 8: Реплей на Astra, слияние, мост, дев, прод (ведущая сессия)

**Files:** `/opt/mila-codex-bridge` (копия моста на деве), `main`, прод `/root/loyalpro_new`.

- [ ] **Step 1: Полный прогон смежных наборов в worktree**

```bash
cd /root/loyalpro/.worktrees/mila-human-tone/backend && export PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH
npx jest agent- reply-style mila-style-metrics dialog-verdicts codex 2>&1 | grep -E "^(Tests:|Test Suites:)|FAIL"
```

Expected: ни одного FAIL.

- [ ] **Step 2: Замер «до» на проде**

```bash
node scripts/mila-style-metrics.js --days=14 --db=loyalpro > /tmp/mila-style-before.json && cat /tmp/mila-style-before.json
```

Expected: числа порядка 27.10 (markdownPct ≈ 28, capitalAddressPct ≈ 55, introsStapled ≈ 22).

- [ ] **Step 3: Реплей на Astra и сравнение с Sol**

```bash
echo 79200255591 | NODE_ENV=development MILA_CODEX_PROTOTYPE=true node scripts/mila-codex-full-prompt.js
cp /tmp/mila-codex-full-prompt-report.json /tmp/mila-tone-replay-astra.json
node -e "
const a=require('/tmp/mila-tone-replay-sol.json'), b=require('/tmp/mila-tone-replay-astra.json');
const med=x=>{const s=x.map(c=>c.ms).filter(Number.isFinite).sort((p,q)=>p-q);return s[Math.floor(s.length/2)]};
console.log('median ms sol/astra', med(a.cases), med(b.cases));
for(const c of b.cases){const o=a.cases.find(x=>x.id===c.id)||{};console.log('\n== '+c.id, (o.ms||'?')+'ms → '+c.ms+'ms');console.log('SOL:   '+(o.answer||o.error||'').replace(/\n/g,' / '));console.log('ASTRA: '+(c.answer||c.error||'').replace(/\n/g,' / '));}"
```

Expected: медиана Astra не больше чем в 1,5 раза против Sol и не больше 30 с; ответы прочитаны на тон. Порог превышен → отдельное решение владельца о `-c model_reasoning_effort="low"` (спека 3.2 п. 7), выкат на прод не делать до него.

- [ ] **Step 4: Слияние в main и push**

```bash
cd /root/loyalpro/.worktrees/mila-human-tone && git fetch origin && git rebase origin/main
cd backend && npx jest agent- reply-style mila-style-metrics dialog-verdicts codex 2>&1 | grep -E "^(Tests:|Test Suites:)|FAIL"
cd .. && git push -u origin feat/mila-human-tone
# fast-forward main без checkout (локальный main в основном дереве отстаёт от origin и не трогается):
git push origin feat/mila-human-tone:main
git log --oneline -1 origin/main
```

Expected: `origin/main` = верхний коммит ветки.

- [ ] **Step 5: Мост на деве**

```bash
ts=$(date -u +%Y%m%dT%H%M%SZ); mkdir -p /root/mila-model-rollback-$ts && cp -a /opt/mila-codex-bridge /root/mila-model-rollback-$ts/bridge
cp /root/loyalpro/.worktrees/mila-human-tone/backend/services/agent/providers/codex.js /opt/mila-codex-bridge/services/agent/providers/codex.js
cp /root/loyalpro/.worktrees/mila-human-tone/backend/services/agent/providers/codex-relay-protocol.js /opt/mila-codex-bridge/services/agent/providers/codex-relay-protocol.js
systemctl restart mila-codex-bridge && sleep 2 && systemctl is-active mila-codex-bridge && curl -s http://127.0.0.1:3012/health
```

Expected: `active` и `{"ok":true,"model":"gpt-6-astra"}`.

- [ ] **Step 6: Дев-бэкенд**

```bash
cd /root/loyalpro && git pull --ff-only origin main 2>/dev/null || echo "основное дерево на другой ветке — дев перезапускается на своём коде"
PORT=3001 pm2 restart loyalpro && sleep 3 && pm2 ls | grep loyalpro && tail -n 3 /root/loyalpro/backend/logs/app-$(date +%F).log
```

Основное дерево `/root/loyalpro` стоит на `feat/notifications-own-module`; дев-процесс берёт код оттуда. Если ветку дева владелец не переключает, Astra на деве появится после слияния этой ветки в неё (`git merge main`), это отдельное решение — зафиксировать в отчёте.

- [ ] **Step 7: Прод**

```bash
ssh root@217.114.0.254 "cd /root/loyalpro_new && git pull origin main && pm2 restart loyalpro && sleep 3 && pm2 ls | grep loyalpro && git log --oneline -1"
```

Expected: `online`, верхний коммит = `origin/main`.

- [ ] **Step 8: Проверка на проде**

Один ход на тестовом номере 79200255591 (в окне расписания 22:00–09:30 или по белому списку), затем:

```bash
ssh root@217.114.0.254 "grep -hE 'reply 79200255591 принят в доставку' /root/loyalpro_new/backend/logs/app-$(date +%F).log | tail -2"
```

и строка маршрутизации (через туннель с дева, только чтение):

```bash
node -e "const {Client}=require('/root/loyalpro/backend/node_modules/pg');require('/root/loyalpro/backend/node_modules/dotenv').config({path:'/root/loyalpro/backend/.env'});const c=new Client({connectionString:process.env.DATABASE_URL.replace('/loyalpro_test','/loyalpro')});c.connect().then(()=>c.query('SELECT active, model, health, last_success_at FROM agent_model_routing WHERE salon_id=1')).then(r=>{console.log(r.rows);return c.end()})"
```

Expected: `active='gpt'`, `model='gpt-6-astra'`, `health='ok'`; в реплике нет `**` и строчного «вы».

- [ ] **Step 9: Память и отчёт**

Обновить заметку памяти `mila_tone_robotic_analysis_2026_10_27.md` (статус: выкачено, дата, коммиты, медианы реплея) и через неделю снять `node scripts/mila-style-metrics.js --days=7 --db=loyalpro` для сравнения с `/tmp/mila-style-before.json`.
