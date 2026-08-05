# Граница переписки и время сообщений в транскрипте — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Мила снова здоровается, когда пациент возвращается после долгого молчания, и видит время каждой реплики в истории.

**Architecture:** Два новых чистых модуля (`session-gap.js` — детект границы переписки по разрыву > 6 ч; `transcript-time.js` — метка `[дд.мм чч:мм]` и её срезание). `history.loadTranscript` начинает возвращать `session` и по флагу `withTime` проставлять метки, а исходящие с `authored_by IS NULL` старше отсечки 04.08.2026 помечать как администраторские. Оркестратор прокидывает `session` в промпт; промпт получает блок «НАЧАЛО НОВОЙ ПЕРЕПИСКИ» в волатильном хвосте.

**Tech Stack:** Node.js (CommonJS), Jest. Все команды — из `/root/loyalpro/backend`.

**Спека:** `docs/superpowers/specs/2026-08-05-agent-session-boundary-design.md`

---

## Файловая структура

| Файл | Ответственность |
|---|---|
| `backend/services/agent/session-gap.js` | **создать** — чистый детект границы переписки |
| `backend/agent-session-gap.test.js` | **создать** — юнит-тесты к нему |
| `backend/services/agent/transcript-time.js` | **создать** — формат/срезание метки времени |
| `backend/agent-transcript-time.test.js` | **создать** — юнит-тесты к нему |
| `backend/services/agent/history.js` | **править** — отсечка авторства, метки, `session` в ответе |
| `backend/agent-history.test.js` | **править** — новые кейсы + починка фикстур |
| `backend/services/agent/system-prompt.js` | **править** — правило 116, блок новой переписки, пояснение метки |
| `backend/agent-system-prompt.test.js` | **править** — новые кейсы |
| `backend/services/agent/orchestrator.js` | **править** — проброс `session`, `withTime`, чистка `allowedTimes` |
| `CLAUDE.md` | **править** — абзац про границу переписки |

---

### Task 1: Модуль `session-gap.js`

**Files:**
- Create: `backend/services/agent/session-gap.js`
- Test: `backend/agent-session-gap.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/agent-session-gap.test.js`:

```js
'use strict';

const { detectSession } = require('./services/agent/session-gap');

const H = 3600;
// Базовое время — произвольная точка, важны только разрывы между сообщениями.
const T = 1_785_900_000;

const inc = (ts, text = 'x') => ({ direction: 'incoming', text, msg_ts: ts });
const out = (ts, text = 'y') => ({ direction: 'outgoing', text, msg_ts: ts });

describe('detectSession', () => {
  test('разрыв больше 6 часов → новая переписка, разрыв словами', () => {
    const r = detectSession([out(T - 7 * 24 * H), inc(T)]);
    expect(r).toEqual({ newSession: true, gapText: '7 дней' });
  });

  test('разрыв меньше 6 часов → та же переписка', () => {
    const r = detectSession([out(T - 5 * H), inc(T)]);
    expect(r).toEqual({ newSession: false, gapText: null });
  });

  test('ровно 6 часов → уже новая переписка (порог включительно)', () => {
    expect(detectSession([out(T - 6 * H), inc(T)]).newSession).toBe(true);
  });

  // Ради этого кейса и написан модуль: после долгого молчания клиент пишет
  // серию сообщений подряд, и разрыв между ДВУМЯ ПОСЛЕДНИМИ — секунды.
  test('серия сообщений подряд после молчания: разрыв меряется до начала серии', () => {
    const rows = [out(T - 7 * 24 * H), inc(T - 20), inc(T - 10), inc(T)];
    expect(detectSession(rows)).toEqual({ newSession: true, gapText: '7 дней' });
  });

  test('серия внутри живого разговора новой перепиской не считается', () => {
    const rows = [out(T - 120), inc(T - 20), inc(T)];
    expect(detectSession(rows).newSession).toBe(false);
  });

  // Задержанное эхо Chatpush получает msg_ts ПОЗЖЕ нового входящего
  // (см. комментарий в history.js) — хвостовая строка может быть outgoing.
  test('задержанное эхо в хвосте не ломает счёт: меряем до серии клиента', () => {
    const rows = [out(T - 7 * 24 * H), inc(T), out(T + 60)];
    expect(detectSession(rows)).toEqual({ newSession: true, gapText: '7 дней' });
  });

  test('единственное сообщение в истории → новая переписка', () => {
    expect(detectSession([inc(T)])).toEqual({ newSession: true, gapText: null });
  });

  test('пустая история → новая переписка', () => {
    expect(detectSession([])).toEqual({ newSession: true, gapText: null });
  });

  test('в окне только сообщения клиента → новая переписка', () => {
    expect(detectSession([inc(T - 10), inc(T)]).newSession).toBe(true);
  });

  test('входящих в окне нет вовсе → не новая переписка', () => {
    expect(detectSession([out(T - 10), out(T)])).toEqual({ newSession: false, gapText: null });
  });

  test('битый msg_ts → не новая переписка (fail-safe, лишнего приветствия не даём)', () => {
    expect(detectSession([out(null), inc(T)])).toEqual({ newSession: false, gapText: null });
  });

  test('порог настраивается', () => {
    expect(detectSession([out(T - 3 * H), inc(T)], { gapHours: 2 }).newSession).toBe(true);
  });

  describe('склонение разрыва', () => {
    const gap = (sec) => detectSession([out(T - sec), inc(T)]).gapText;
    test('часы: 6/7/21', () => {
      expect(gap(6 * H)).toBe('6 часов');
      expect(gap(7 * H)).toBe('7 часов');
      expect(gap(21 * H)).toBe('21 час');
    });
    test('до 48 часов считаем в часах', () => {
      expect(gap(47 * H)).toBe('47 часов');
    });
    test('от 48 часов — в сутках, округление вниз', () => {
      expect(gap(48 * H)).toBe('2 дня');
      expect(gap(71 * H)).toBe('2 дня');
      expect(gap(5 * 24 * H)).toBe('5 дней');
      expect(gap(21 * 24 * H)).toBe('21 день');
    });
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd /root/loyalpro/backend && npx jest agent-session-gap`
Expected: FAIL — `Cannot find module './services/agent/session-gap'`

- [ ] **Step 3: Реализовать модуль**

Создать `backend/services/agent/session-gap.js`:

```js
'use strict';

// Граница «новой переписки» — разрыв между текущей серией сообщений пациента и
// предыдущим сообщением диалога.
//
// ЗАЧЕМ: транскрипт грузится с LIMIT 20 и БЕЗ окна по времени, поэтому диалог,
// возобновлённый через неделю, для модели неотличим от продолжающегося, и
// правило промпта «здоровайся один раз за диалог» срабатывает на ложной посылке.
// Инцидент 2026-08-05 (79299761316): пациентка написала «Доброе утро», Мила
// ответила без приветствия — в окне лежала переписка от 29.07, где с пациенткой
// здоровался живой администратор.
const DEFAULT_GAP_HOURS = 6;

// Русское склонение: 1 час / 2 часа / 5 часов.
function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

// Разрыв словами, округление ВНИЗ: до 48 часов — в часах, дальше — в сутках.
// Идёт прямо в промпт, поэтому формулировка человеческая, а не «604800 сек».
function formatGap(sec) {
  const hours = Math.floor(sec / 3600);
  if (hours < 48) return `${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

// msg_ts приходит из PG строкой (bigint), из pending — числом. Number(null) === 0,
// поэтому проверять одним Number.isFinite нельзя: битый ts дал бы разрыв «с 1970».
function toTs(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// rows — сырые строки транскрипта в ХРОНОЛОГИЧЕСКОМ порядке (до склейки серий и
// до переноса хвостового assistant-блока: обе операции теряют границы сообщений).
// → { newSession, gapText }, gapText непуст только при newSession.
function detectSession(rows, opts = {}) {
  const gapHours = Number(opts.gapHours) > 0 ? Number(opts.gapHours) : DEFAULT_GAP_HOURS;
  const list = Array.isArray(rows) ? rows : [];
  if (list.length < 2) return { newSession: true, gapText: null };

  // Последнее входящее, а не последняя строка: задержанное эхо Chatpush получает
  // msg_ts ПОЗЖЕ нового входящего и стоит в хвосте (см. history.js).
  let last = -1;
  for (let k = list.length - 1; k >= 0; k--) {
    if (list[k].direction === 'incoming') { last = k; break; }
  }
  if (last < 0) return { newSession: false, gapText: null };   // входящих в окне нет

  // Начало ХВОСТОВОЙ СЕРИИ сообщений пациента. Сравнивать два последних сообщения
  // нельзя: после долгого молчания клиент часто пишет 2-3 сообщения подряд, и
  // разрыв между ними — секунды, то есть ровно наш случай был бы не виден.
  let start = last;
  while (start > 0 && list[start - 1].direction === 'incoming') start--;
  if (start === 0) return { newSession: true, gapText: null };   // в окне только клиент

  const prev = toTs(list[start - 1].msg_ts);
  const burstStart = toTs(list[start].msg_ts);
  // Битый ts → молчим: лишнее приветствие заметнее пациенту, чем его отсутствие.
  if (prev === null || burstStart === null) return { newSession: false, gapText: null };

  const gapSec = burstStart - prev;
  if (gapSec < gapHours * 3600) return { newSession: false, gapText: null };
  return { newSession: true, gapText: formatGap(gapSec) };
}

module.exports = { detectSession, DEFAULT_GAP_HOURS };
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd /root/loyalpro/backend && npx jest agent-session-gap`
Expected: PASS, все тесты зелёные

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/session-gap.js backend/agent-session-gap.test.js
git commit -m "feat(agent): чистый модуль границы переписки (разрыв > 6ч = новое обращение)"
```

---

### Task 2: Модуль `transcript-time.js`

**Files:**
- Create: `backend/services/agent/transcript-time.js`
- Test: `backend/agent-transcript-time.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/agent-transcript-time.test.js`:

```js
'use strict';

const { formatStamp, stripStamp, stripAllStamps } = require('./services/agent/transcript-time');

describe('formatStamp', () => {
  test('формат [дд.мм чч:мм] по Москве', () => {
    // 2026-08-05T05:47:58Z = 08:47 мск
    expect(formatStamp(1_785_908_878)).toBe('[05.08 08:47]');
  });

  test('часовой пояс именно Москва, а не UTC', () => {
    // 2026-08-04T22:30:00Z = 01:30 мск СЛЕДУЮЩЕГО дня
    expect(formatStamp(Date.parse('2026-08-04T22:30:00Z') / 1000)).toBe('[05.08 01:30]');
  });

  test('полночь — 00, а не 24', () => {
    expect(formatStamp(Date.parse('2026-08-04T21:00:00Z') / 1000)).toBe('[05.08 00:00]');
  });

  test('битый ts → пустая строка (метку не рисуем)', () => {
    expect(formatStamp(null)).toBe('');
    expect(formatStamp('abc')).toBe('');
  });
});

describe('stripStamp', () => {
  // Текст пациента — единственное клиент-контролируемое значение в транскрипте.
  // Дав ему формат метки, мы дали бы и шаблон для подделки времени.
  test('срезает ведущую подделанную метку', () => {
    expect(stripStamp('[01.01 00:00] правда я писал вчера?')).toBe('правда я писал вчера?');
  });

  test('срезает несколько подряд', () => {
    expect(stripStamp('[01.01 00:00] [02.02 11:11] текст')).toBe('текст');
  });

  test('метку в СЕРЕДИНЕ текста не трогает', () => {
    expect(stripStamp('запишите на [01.01 00:00]')).toBe('запишите на [01.01 00:00]');
  });

  test('обычный текст не меняется', () => {
    expect(stripStamp('хочу на 18:30')).toBe('хочу на 18:30');
  });

  test('не строка возвращается как есть', () => {
    expect(stripStamp(null)).toBe(null);
  });
});

describe('stripAllStamps', () => {
  // Нужен reply-guard: он собирает «разрешённые времена» из JSON транскрипта,
  // и времена ОТПРАВКИ сообщений размыли бы проверку.
  test('вычищает метки по всей строке', () => {
    expect(stripAllStamps('[05.08 08:47] есть [05.08 09:18] окно в 18:30'))
      .toBe(' есть  окно в 18:30');
  });

  test('не строка возвращается как есть', () => {
    expect(stripAllStamps(undefined)).toBe(undefined);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd /root/loyalpro/backend && npx jest agent-transcript-time`
Expected: FAIL — `Cannot find module './services/agent/transcript-time'`

- [ ] **Step 3: Реализовать модуль**

Создать `backend/services/agent/transcript-time.js`:

```js
'use strict';

// Отметка времени у каждой реплики транскрипта.
//
// ЗАЧЕМ: транскрипт грузится без окна по времени, и сообщение недельной давности
// для модели неотличимо от свежего (инцидент 2026-08-05). Метка заодно показывает,
// насколько устарели названные в переписке слоты и цены.
// Держится в паре с пояснением формата в промпте (system-prompt.js,
// раздел ТЕКУЩИЙ КОНТЕКСТ) — менять только вместе, связано тестом.

const LEADING_STAMP_RE = /^\s*\[\d{2}\.\d{2} \d{2}:\d{2}\]\s*/;
const ANY_STAMP_RE = /\[\d{2}\.\d{2} \d{2}:\d{2}\]/g;

// hourCycle h23 обязателен: с hour12:false Intl в ряде локалей даёт «24:00».
const FMT = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// tsSec — unix-секунды: msg_ts в chatpush_messages и ts из pendingReplies.peek().
function formatStamp(tsSec) {
  const ms = Number(tsSec) * 1000;
  if (!Number.isFinite(ms)) return '';
  const p = {};
  for (const part of FMT.formatToParts(new Date(ms))) p[part.type] = part.value;
  return `[${p.day}.${p.month} ${p.hour}:${p.minute}]`;
}

// Ведущая метка во ВХОДЯЩЕМ тексте — подделка: настоящую ставим мы сами.
function stripStamp(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  while (LEADING_STAMP_RE.test(out)) out = out.replace(LEADING_STAMP_RE, '');
  return out;
}

// Все метки в произвольной строке — для reply-guard, который сканирует
// сериализованный транскрипт и иначе принял бы времена отправки за предложенные.
function stripAllStamps(text) {
  return typeof text === 'string' ? text.replace(ANY_STAMP_RE, '') : text;
}

module.exports = { formatStamp, stripStamp, stripAllStamps };
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd /root/loyalpro/backend && npx jest agent-transcript-time`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/transcript-time.js backend/agent-transcript-time.test.js
git commit -m "feat(agent): метка времени реплики в транскрипте (формат + защита от подделки)"
```

---

### Task 3: Отсечка авторства старых исходящих в `history.js`

Причина (б) инцидента: у сообщений до 04.08.2026 `authored_by = NULL`, среди них есть реплики живых администраторов, и они уходят в промпт как собственные реплики Милы.

**Files:**
- Modify: `backend/services/agent/history.js`
- Test: `backend/agent-history.test.js`

- [ ] **Step 1: Написать падающий тест**

В `backend/agent-history.test.js` заменить тест «старые сообщения без отметки автора ведут себя как раньше» (строки 57–65) на два теста:

```js
    // Отсечка = момент выката журнала авторства (04.08.2026, коммит 34caa25).
    // До неё NULL означает «автор неизвестен, вероятно администратор»; после —
    // «classify упал» (там намеренный fail-open, чтобы не глушить Милу на её
    // же эхе), и такое NULL оператором считать нельзя.
    test('исходящее без автора СТАРШЕ отсечки помечается как администраторское', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'ок', msg_ts: 1_785_000_000 },
        { direction: 'outgoing', msg_type: 'text', text: 'Доброе утро!', msg_ts: 1_753_000_000, authored_by: null },
        { direction: 'incoming', msg_type: 'text', text: 'да', msg_ts: 1_752_000_000 },
      ]);
      const { messages } = await history.loadTranscript(1, 'k');
      expect(messages.find(m => m.role === 'assistant').content)
        .toBe(`${history.OPERATOR_MARK} Доброе утро!`);
    });

    test('исходящее без автора ПОСЛЕ отсечки своим и остаётся (fail-open classify)', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'ок', msg_ts: 1_786_000_100 },
        { direction: 'outgoing', msg_type: 'text', text: 'Записала вас', msg_ts: 1_786_000_000, authored_by: null },
        { direction: 'incoming', msg_type: 'text', text: 'да', msg_ts: 1_785_999_000 },
      ]);
      const { messages } = await history.loadTranscript(1, 'k');
      expect(messages.find(m => m.role === 'assistant').content).toBe('Записала вас');
    });
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd /root/loyalpro/backend && npx jest agent-history`
Expected: FAIL — первый новый тест ждёт `[сообщение администратора клиники] Доброе утро!`, получает `Доброе утро!`

- [ ] **Step 3: Реализовать отсечку**

В `backend/services/agent/history.js` после константы `OPERATOR_MARK` (строка 12) добавить:

```js
// Журнал авторства исходящих (services/outgoing-authorship) выкачен на прод
// 04.08.2026 (коммит 34caa25). У сообщений ДО него authored_by = NULL, и среди
// них есть реплики живых администраторов — без пометки модель считает их своими
// (инцидент 2026-08-05: пациентке не ответили приветствием, потому что неделю
// назад с ней здоровался администратор, а его «Доброе утро» числилось за Милой).
// ПОСЛЕ отсечки NULL значит ДРУГОЕ: classify упал, а там намеренный fail-open,
// чтобы не глушить Милу на её же эхе, — такое NULL оператором НЕ считаем.
// Отсечка взята концом суток 04.08 мск: ошибка в эту сторону заставит Милу лишний
// раз перепроверить собственную договорённость, ошибка в другую — исходный баг.
const AUTHORSHIP_SINCE_TS = Math.floor(Date.parse('2026-08-05T00:00:00+03:00') / 1000);
```

Заменить строку 56:

```js
    const text = r.authored_by === 'operator' ? `${OPERATOR_MARK} ${r.text}` : r.text;
```

на:

```js
    const legacyUnknown = r.direction === 'outgoing'
      && r.authored_by == null
      && Number(r.msg_ts) < AUTHORSHIP_SINCE_TS;
    const text = (r.authored_by === 'operator' || legacyUnknown)
      ? `${OPERATOR_MARK} ${r.text}`
      : r.text;
```

В блоке подмешивания pending (строка 38) проставить автора явно — это всегда наши собственные отправки, и полагаться на их ts не нужно:

```js
      .map((p) => ({ direction: 'outgoing', text: p.text, msg_ts: p.ts, authored_by: 'agent' }));
```

- [ ] **Step 4: Убедиться, что новые тесты проходят, и починить фикстуры**

Run: `cd /root/loyalpro/backend && npx jest agent-history`

Упадут два старых теста, где исходящее Милы задано без `authored_by` и с игрушечным `msg_ts` (то есть «до отсечки»). Это фикстуры, а не регресс — проставить в них реального автора:

- тест «assistant-хвост вливается в предыдущий assistant-блок» — добавить `authored_by: 'agent'` в обе строки `outgoing` (`'позднее эхо'`, `'старый ответ'`);
- тест «эхо уже в БД → pending с тем же текстом не дублируется» — добавить `authored_by: 'agent'` в строку `outgoing` (`'Ответ'`).

Run: `cd /root/loyalpro/backend && npx jest agent-history`
Expected: PASS, все тесты файла зелёные

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/history.js backend/agent-history.test.js
git commit -m "fix(agent): исходящие без автора до 04.08 помечаются как администраторские"
```

---

### Task 4: `session` и метки времени в `loadTranscript`

**Files:**
- Modify: `backend/services/agent/history.js`
- Test: `backend/agent-history.test.js`

- [ ] **Step 1: Написать падающий тест**

Добавить в `backend/agent-history.test.js` новый блок (внутри `describe('loadTranscript', …)`):

```js
  describe('граница переписки и метки времени', () => {
    const H = 3600;
    const T = 1_786_000_000;

    test('session отдаётся вместе с транскриптом', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'доброе утро', msg_ts: T },
        { direction: 'outgoing', msg_type: 'text', text: 'Добрый день!', msg_ts: T - 7 * 24 * H, authored_by: 'agent' },
        { direction: 'incoming', msg_type: 'text', text: 'здравствуйте', msg_ts: T - 7 * 24 * H - 60 },
      ]);
      const { session } = await history.loadTranscript(1, 'k');
      expect(session).toEqual({ newSession: true, gapText: '7 дней' });
    });

    test('живой разговор → session.newSession false', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'да', msg_ts: T },
        { direction: 'outgoing', msg_type: 'text', text: 'Есть 18:30', msg_ts: T - 120, authored_by: 'agent' },
        { direction: 'incoming', msg_type: 'text', text: 'что есть?', msg_ts: T - 240 },
      ]);
      const { session } = await history.loadTranscript(1, 'k');
      expect(session.newSession).toBe(false);
    });

    test('withTime: метка у каждой реплики, у операторской — перед пометкой автора', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'ок', msg_ts: Date.parse('2026-08-05T05:47:58Z') / 1000 },
        { direction: 'outgoing', msg_type: 'text', text: 'Доброе утро!', msg_ts: Date.parse('2026-07-29T06:44:39Z') / 1000, authored_by: 'operator' },
        { direction: 'incoming', msg_type: 'text', text: 'есть ялупро?', msg_ts: Date.parse('2026-07-29T06:09:04Z') / 1000 },
      ]);
      const { messages } = await history.loadTranscript(1, 'k', { withTime: true });
      expect(messages).toEqual([
        { role: 'user', content: '[29.07 09:09] есть ялупро?' },
        { role: 'assistant', content: `[29.07 09:44] ${history.OPERATOR_MARK} Доброе утро!` },
        { role: 'user', content: '[05.08 08:47] ок' },
      ]);
    });

    test('без withTime меток нет (care-воркер зовёт именно так)', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'ок', msg_ts: T },
      ]);
      const { messages } = await history.loadTranscript(1, 'k');
      expect(messages).toEqual([{ role: 'user', content: 'ок' }]);
    });

    test('подделанная клиентом метка срезается', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: '[01.01 00:00] я писал вчера', msg_ts: Date.parse('2026-08-05T05:47:58Z') / 1000 },
      ]);
      const { messages } = await history.loadTranscript(1, 'k', { withTime: true });
      expect(messages).toEqual([{ role: 'user', content: '[05.08 08:47] я писал вчера' }]);
    });
  });
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd /root/loyalpro/backend && npx jest agent-history -t "граница переписки"`
Expected: FAIL — `session` приходит `undefined`, метки не проставляются

- [ ] **Step 3: Реализовать**

В `backend/services/agent/history.js` добавить импорты после строки 4:

```js
const sessionGap = require('./session-gap');
const { formatStamp, stripStamp } = require('./transcript-time');
```

В `loadTranscript` после строки 18 (`const limit = …`) добавить:

```js
  // Метки времени включает только оркестратор: care-воркер (services/care/worker.js)
  // собирает из этого же транскрипта свой промпт, и метки там не нужны.
  const withTime = !!opts.withTime;
```

Сразу ПОСЛЕ блока подмешивания pending (после строки 43, закрывающей `if (pending.length)`) и ДО сборки `messages` добавить:

```js
  // Граница переписки считается на СЫРЫХ строках: ниже серии склеиваются, а
  // хвостовой assistant-блок переносится — границы сообщений теряются.
  const session = sessionGap.detectSession(rows);
```

Заменить формирование `text` (после правки Task 3) на:

```js
    const legacyUnknown = r.direction === 'outgoing'
      && r.authored_by == null
      && Number(r.msg_ts) < AUTHORSHIP_SINCE_TS;
    // Ведущая метка во входящем тексте — подделка клиента: настоящую ставим мы.
    let body = r.direction === 'incoming' ? stripStamp(r.text) : r.text;
    if (r.authored_by === 'operator' || legacyUnknown) body = `${OPERATOR_MARK} ${body}`;
    const text = withTime ? `${formatStamp(r.msg_ts)} ${body}` : body;
```

Заменить возврат (строка 86):

```js
  return { messages, watermark, session };
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd /root/loyalpro/backend && npx jest agent-history`
Expected: PASS, все тесты файла зелёные

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/history.js backend/agent-history.test.js
git commit -m "feat(agent): транскрипт отдаёт границу переписки и метки времени реплик"
```

---

### Task 5: Промпт — блок новой переписки и пояснение метки

**Files:**
- Modify: `backend/services/agent/system-prompt.js:116`, `:366`, `:374`
- Test: `backend/agent-system-prompt.test.js`

- [ ] **Step 1: Написать падающий тест**

Добавить в `backend/agent-system-prompt.test.js` новый блок (импорт `buildSystemPrompt` в файле уже есть — использовать его):

```js
describe('граница новой переписки', () => {
  const base = { salonName: 'PERI CLINIC', today: '5 августа 2026, вторник', now: '08:47' };

  test('блок появляется при newSession и называет разрыв', () => {
    const p = buildSystemPrompt({ ...base, session: { newSession: true, gapText: '7 дней' } });
    expect(p).toContain('НАЧАЛО НОВОЙ ПЕРЕПИСКИ');
    expect(p).toContain('7 дней назад');
  });

  test('без newSession блока нет', () => {
    const p = buildSystemPrompt({ ...base, session: { newSession: false, gapText: null } });
    expect(p).not.toContain('НАЧАЛО НОВОЙ ПЕРЕПИСКИ');
  });

  test('session вовсе не передан → блока нет (обратная совместимость)', () => {
    expect(buildSystemPrompt(base)).not.toContain('НАЧАЛО НОВОЙ ПЕРЕПИСКИ');
  });

  test('newSession без gapText → блок есть, формулировка без числа', () => {
    const p = buildSystemPrompt({ ...base, session: { newSession: true, gapText: null } });
    expect(p).toContain('НАЧАЛО НОВОЙ ПЕРЕПИСКИ');
    expect(p).toContain('давно');
  });

  // Блок волатильный: он МЕНЯЕТСЯ от хода к ходу, и выше «Сейчас по Москве»
  // его класть нельзя — порвёт кэшируемый префикс промпта.
  test('блок стоит ПОСЛЕ «Сейчас по Москве» — префикс-кэш цел', () => {
    const p = buildSystemPrompt({ ...base, session: { newSession: true, gapText: '7 дней' } });
    expect(p.indexOf('НАЧАЛО НОВОЙ ПЕРЕПИСКИ')).toBeGreaterThan(p.indexOf('Сейчас по Москве'));
  });

  // Правило 116 больше не должно запрещать приветствие «за весь диалог» —
  // иначе оно противоречит блоку выше.
  test('правило приветствия говорит про ТЕКУЩИЙ разговор, а не про весь диалог', () => {
    const p = buildSystemPrompt(base);
    expect(p).not.toContain('Здоровайся ТОЛЬКО ОДИН раз за весь диалог');
    expect(p).toContain('в рамках ТЕКУЩЕГО разговора');
  });
});

describe('пояснение метки времени', () => {
  test('формат метки в промпте совпадает с тем, что ставит history', () => {
    const { formatStamp } = require('./services/agent/transcript-time');
    const p = buildSystemPrompt({ salonName: 'PERI CLINIC', today: 'x', now: '10:00' });
    expect(p).toContain('[дд.мм чч:мм]');
    // Реальная метка обязана соответствовать заявленному промптом шаблону.
    expect(formatStamp(1_785_908_878)).toMatch(/^\[\d{2}\.\d{2} \d{2}:\d{2}\]$/);
  });

  test('правило про реплики администратора не требует, чтобы строка НАЧИНАЛАСЬ с пометки', () => {
    const p = buildSystemPrompt({ salonName: 'PERI CLINIC', today: 'x', now: '10:00' });
    expect(p).not.toContain('Строки, начинающиеся с «[сообщение администратора клиники]»');
    expect(p).toContain('[сообщение администратора клиники]');
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd /root/loyalpro/backend && npx jest agent-system-prompt -t "граница новой переписки"`
Expected: FAIL — блока в промпте нет

- [ ] **Step 3: Реализовать**

В `backend/services/agent/system-prompt.js` после строки 47 (`const resumed = …`) добавить разбор опции:

```js
  // Граница переписки (services/agent/session-gap, считает history.loadTranscript).
  // Транскрипт грузится без окна по времени, поэтому возобновлённый через неделю
  // диалог для модели неотличим от продолжающегося — инцидент 2026-08-05.
  const session = opts.session && typeof opts.session === 'object' ? opts.session : null;
  const newSession = !!(session && session.newSession);
  const sessionGapText = sanitizeLine(session && session.gapText, 40);
```

Заменить строку 116:

```js
    `- Здоровайся ТОЛЬКО ОДИН раз за весь диалог. Если приветствие уже прозвучало в первом сообщении — в следующих ответах сразу переходи к делу, ДАЖЕ когда только что узнала имя пациента. Никаких повторных «Здравствуйте», «Добрый день», «Здравствуйте, {имя}!».`,
```

на:

```js
    `- Здоровайся ТОЛЬКО ОДИН раз в рамках ТЕКУЩЕГО разговора. Если приветствие уже прозвучало — в следующих ответах сразу переходи к делу, ДАЖЕ когда только что узнала имя пациента. Никаких повторных «Здравствуйте», «Добрый день», «Здравствуйте, {имя}!». Исключение одно: если ниже, в разделе ТЕКУЩИЙ КОНТЕКСТ, сказано, что началась НОВАЯ ПЕРЕПИСКА, — поздоровайся заново, приветствие из прошлого разговора не считается.`,
```

В разделе `ТЕКУЩИЙ КОНТЕКСТ` (строка 366) сразу ПОСЛЕ строки `Часы работы КЛИНИКИ: …` добавить пояснение метки и условный блок:

```js
    `В истории переписки каждая реплика начинается с отметки времени в формате [дд.мм чч:мм] по Москве. Это служебная пометка: сама её никогда не пиши и пациенту не показывай. По ней видно, насколько давно прозвучали названные в переписке цены и время — устаревшее перепроверяй инструментами.`,
    // Волатильный блок: стоит НИЖЕ «Сейчас по Москве», которая и так меняется
    // каждый ход, поэтому кэшируемому префиксу промпта он ничего не стоит.
    ...(newSession ? [
      ``,
      `НАЧАЛО НОВОЙ ПЕРЕПИСКИ:`,
      `Предыдущий разговор с этим пациентом закончился ${sessionGapText ? `${sessionGapText} назад` : 'давно'} — это новое обращение. Поздоровайся заново, как в начале диалога. Всё, о чём говорили в прошлый раз, могло устареть: цены, свободное время и записи перепроверяй инструментами, а не по истории.`,
    ] : []),
```

Заменить строку 374:

```js
    `Строки, начинающиеся с «[сообщение администратора клиники]», писала НЕ ты, а живой сотрудник клиники. Это служебная пометка: сама её никогда не пиши и пациенту не показывай.`,
```

на:

```js
    `Реплики с пометкой «[сообщение администратора клиники]» писала НЕ ты, а живой сотрудник клиники (пометка стоит сразу после отметки времени). Это служебная пометка: сама её никогда не пиши и пациенту не показывай.`,
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd /root/loyalpro/backend && npx jest agent-system-prompt`
Expected: PASS, включая существующие тесты префикс-кэша

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js
git commit -m "feat(agent): промпт-блок «начало новой переписки» + пояснение метки времени"
```

---

### Task 6: Проброс в оркестраторе

**Files:**
- Modify: `backend/services/agent/orchestrator.js:281-301`, `:313`, `:335`

- [ ] **Step 1: Написать падающий тест**

Добавить в `backend/agent-orchestrator.test.js`, в существующий `describe('runDialog', …)`. Хелперы `makeDeps` и `textResp` уже объявлены в начале файла — использовать их:

```js
  // Инцидент 2026-08-05: диалог, возобновлённый через неделю, был неотличим от
  // продолжающегося, и Мила не поздоровалась.
  test('транскрипт грузится с метками времени, граница переписки уходит в промпт', async () => {
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [{ role: 'user', content: '[05.08 08:47] доброе утро' }],
          watermark: 100,
          session: { newSession: true, gapText: '7 дней' },
        })),
      },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте! 🤍'));
    await orchestrator.runDialog(1, 'k', { deps });

    expect(deps.history.loadTranscript.mock.calls[0][2]).toMatchObject({ withTime: true });
    const { system } = deps.provider.createMessage.mock.calls[0][0];
    expect(system).toContain('НАЧАЛО НОВОЙ ПЕРЕПИСКИ');
    expect(system).toContain('7 дней назад');
  });

  test('без границы переписки блока в промпте нет', async () => {
    const deps = makeDeps();   // дефолтный loadTranscript отдаёт транскрипт без session
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Есть окошко в 18:30'));
    await orchestrator.runDialog(1, 'k', { deps });
    const { system } = deps.provider.createMessage.mock.calls[0][0];
    expect(system).not.toContain('НАЧАЛО НОВОЙ ПЕРЕПИСКИ');
  });
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd /root/loyalpro/backend && npx jest agent-orchestrator -t "метками времени"`
Expected: FAIL — `withTime` undefined, блока в промпте нет

- [ ] **Step 3: Реализовать**

В `backend/services/agent/orchestrator.js`:

1. Добавить импорт рядом с остальными (после строки 17):

```js
const { stripAllStamps } = require('./transcript-time');
```

2. Строку 281 `const system = buildSystemPrompt({` заменить на `const promptOpts = {`, а закрывающую строку 301 `});` — на `};`. Тело объекта не трогать.

3. Внутри цикла попыток заменить строку 313:

```js
    const { messages, watermark } = await history.loadTranscript(salonId, dialogKey, { limit: 20 });
```

на:

```js
    const { messages, watermark, session } = await history.loadTranscript(
      salonId, dialogKey, { limit: 20, withTime: true });
```

4. Сразу после строки `const convo = messages.slice();` добавить сборку промпта:

```js
    // Промпт собирается ВНУТРИ цикла: граница переписки известна только после
    // загрузки транскрипта. Сборка — конкатенация строк, перегенераций не больше
    // MAX_REGEN, поэтому цена пренебрежимая.
    const system = buildSystemPrompt({ ...promptOpts, session });
```

5. Заменить строку сбора разрешённых времён (была 334):

```js
    const allowedTimes = new Set(replyGuard.extractTimes(JSON.stringify(messages)));
```

на:

```js
    // Метки времени реплик — НЕ предложенные пациенту времена: без чистки
    // reply-guard считал бы разрешённым любое время отправки сообщения.
    const allowedTimes = new Set(replyGuard.extractTimes(stripAllStamps(JSON.stringify(messages))));
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd /root/loyalpro/backend && npx jest agent-orchestrator`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/orchestrator.js backend/agent-orchestrator.test.js
git commit -m "feat(agent): оркестратор прокидывает границу переписки и метки времени в промпт"
```

---

### Task 7: Прогон всей сюиты и документация

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Прогнать весь бэкенд-сьют**

Run: `cd /root/loyalpro/backend && npx jest --testPathIgnorePatterns 'primary-clients'`

`primary-clients.test.js` исключён намеренно: он зовёт `process.exit(1)` и убивает соседний сьют — известная плавающая помеха, не связанная с этой работой.

Expected: PASS. Если падает `care-prompt.test.js` или `care-worker.test.js` — значит `withTime` где-то протёк в care-путь; проверить, что `services/care/worker.js:259` зовёт `loadTranscript` БЕЗ `withTime`.

- [ ] **Step 2: Проверить сборку промпта живьём**

```bash
cd /root/loyalpro/backend && node -e "
const { buildSystemPrompt } = require('./services/agent/system-prompt');
const a = buildSystemPrompt({ salonName:'PERI CLINIC', today:'5 августа 2026, вторник', now:'08:47' });
const b = buildSystemPrompt({ salonName:'PERI CLINIC', today:'5 августа 2026, вторник', now:'08:47', session:{newSession:true, gapText:'7 дней'} });
console.log('блок есть:', b.includes('НАЧАЛО НОВОЙ ПЕРЕПИСКИ'));
console.log('общий префикс, симв.:', (()=>{let i=0; while(i<a.length && a[i]===b[i]) i++; return i;})(), 'из', a.length);
"
```

Expected: `блок есть: true`, а общий префикс — заметно больше половины длины промпта (блок вставляется в самом хвосте, кэшируемая часть цела).

- [ ] **Step 3: Дописать абзац в CLAUDE.md**

В `CLAUDE.md`, в раздел «AI-агент: управление и гейт допуска», добавить пункт после абзаца про авторство исходящих:

```markdown
- Граница переписки (`services/agent/session-gap.js`, чистый модуль, тесты `agent-session-gap.test.js`): транскрипт грузится с `LIMIT 20` и БЕЗ окна по времени, поэтому диалог, возобновлённый через неделю, для модели неотличим от продолжающегося — правило «здоровайся один раз за диалог» срабатывало на ложной посылке. Инцидент 2026-08-05 (79299761316): пациентка написала «Доброе утро», Мила ответила по делу без приветствия — в окне лежала переписка от 29.07, где с ней здоровался живой АДМИНИСТРАТОР, а у того сообщения `authored_by = NULL` (до выката журнала авторства 04.08), поэтому `OPERATOR_MARK` к нему не приклеился. Три слоя: (1) `detectSession` меряет разрыв между ХВОСТОВОЙ СЕРИЕЙ сообщений пациента и предыдущим сообщением — именно серией, иначе «2 сообщения подряд после недели молчания» дают разрыв в секунды; > 6 ч → `newSession` и блок «НАЧАЛО НОВОЙ ПЕРЕПИСКИ» в ВОЛАТИЛЬНОМ хвосте промпта, ниже «Сейчас по Москве» (выше нельзя — порвёт префикс-кэш), правило 116 переформулировано с «за весь диалог» на «в рамках ТЕКУЩЕГО разговора»; (2) `AUTHORSHIP_SINCE_TS` в `history.js` — исходящее с `authored_by IS NULL` СТАРШЕ 05.08.2026 00:00 мск читается как операторское, ПОСЛЕ отсечки `NULL` значит «`classify` упал» (fail-open, иначе глушили бы Милу на её же эхе) и оператором НЕ считается; (3) метка `[дд.мм чч:мм]` у каждой реплики (`transcript-time.js`), включается флагом `withTime` только из оркестратора — care-воркер зовёт `loadTranscript` без него. ГОТЧИ: `detectSession` считается на СЫРЫХ строках до склейки серий и до переноса хвостового assistant-блока (обе операции теряют границы сообщений); ведущая метка во ВХОДЯЩЕМ тексте срезается (`stripStamp`) — иначе формат метки становится шаблоном для подделки; `allowedTimes` в оркестраторе чистится `stripAllStamps`, иначе reply-guard считает разрешённым любое время ОТПРАВКИ сообщения; pending-реплики подмешиваются с `authored_by:'agent'` явно, чтобы не зависеть от их ts на отсечке.
```

- [ ] **Step 4: Финальный прогон**

Run: `cd /root/loyalpro/backend && npx jest --testPathIgnorePatterns 'primary-clients'`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add CLAUDE.md
git commit -m "docs: граница переписки и метки времени в транскрипте Милы"
```

---

## Что этот план НЕ делает

Из того же разбора остались две находки, вынесенные за рамки (см. хвост спеки):

1. **Отсечка доставки MAX до 09:00 на стороне Chatpush** — причина «ответа через 15 минут». Мила отдала реплику за 62 с; чинится настройками MAX-инстанса, а не кодом.
2. **Обрыв диалога на `gate skip outside-schedule` в 09:30** — Мила спросила имя и замолчала, бронь через 12 минут оформил человек. Кандидат на грейс-период.
