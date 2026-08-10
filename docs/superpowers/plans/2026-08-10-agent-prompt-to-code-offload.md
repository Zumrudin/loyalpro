# Перевод промпт-правил Милы в код — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Снять два класса LLM-проходов (оценка визита, «+» на акцию) и поставить детерминированные рубежи под четыре хрупких промпт-правила (диапазоны цен, цена Ботулакса, запись на неназванный препарат, повтор должности) + телеметрия повтора «в подарок».

**Architecture:** Всё — по устоявшимся паттернам проекта: чистые модули в `backend/services/agent/` с jest-тестами в `backend/agent-*.test.js`, интеграция в `orchestrator.js` (проверки до провайдера — как `closing.js`; постпроцессоры реплик — как `ensureGreeting`; hint-ответы инструментов — как `too_soon`). Спека: `docs/superpowers/specs/2026-08-10-agent-prompt-to-code-offload.md`.

**Tech Stack:** Node.js/Express, jest (запуск из `/root/loyalpro/backend`), без новых зависимостей.

**Важно для исполнителя:**
- Рабочая директория тестов: `cd /root/loyalpro/backend`. Полный прогон — `npx jest --testPathIgnorePatterns=primary-clients.test.js` (primary-clients зовёт process.exit и валит соседний сьют — известный флейк, память `jest_full_run_flake_primary_clients`).
- Промпт защищён тестами (`agent-system-prompt.test.js`): любая правка формулировок → прогнать этот сьют и обновить ассерты, цитирующие старую формулировку, СОХРАНЯЯ смысловые проверки.
- Коммиты — в main, сообщения на русском в стиле репо (`feat(agent): …` / `fix(agent): …`), в конце: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- НЕ рестартовать pm2 в рамках этого плана (дев-процесс подхватит код при следующем штатном рестарте; готча `feedback_dev_pm2_port_gotcha`: только `PORT=3001 pm2 restart loyalpro` без `--update-env`).

---

## Task 1: `history.lastOutgoingAuthor` — автор последнего исходящего

**Files:**
- Modify: `backend/services/agent/history.js` (после `hasAgentEverWritten`, ~строка 236)
- Test: `backend/agent-history.test.js` (в конец файла)

- [ ] **Step 1: Написать падающий тест**

В конец `backend/agent-history.test.js` добавить (стиль моков файла: `jest.mock('./db')` уже объявлен в шапке, `db.oneOrNone` доступен):

```js
// ── lastOutgoingAuthor: автор последнего исходящего (спека 2026-08-10-agent-prompt-to-code-offload) ──
// Детерминированные ветки оркестратора (оценка визита, «+» на акцию) включаются
// ТОЛЬКО когда последнее слово клиники — автоуведомление (authored_by='system').
describe('lastOutgoingAuthor', () => {
  test('отдаёт authored_by последнего исходящего', async () => {
    db.oneOrNone.mockResolvedValue({ authored_by: 'system' });
    expect(await history.lastOutgoingAuthor(1, '79001112233')).toBe('system');
    const [sql, params] = db.oneOrNone.mock.calls[0];
    expect(sql).toMatch(/direction = 'outgoing'/);
    expect(sql).toMatch(/ORDER BY/);
    expect(sql).toMatch(/LIMIT 1/);
    expect(params).toEqual([1, '79001112233']);
  });

  test('исходящих нет → null', async () => {
    db.oneOrNone.mockResolvedValue(null);
    expect(await history.lastOutgoingAuthor(1, 'k')).toBe(null);
  });

  test('authored_by не проставлен (NULL в строке) → null', async () => {
    db.oneOrNone.mockResolvedValue({ authored_by: null });
    expect(await history.lastOutgoingAuthor(1, 'k')).toBe(null);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd /root/loyalpro/backend && npx jest agent-history -t lastOutgoingAuthor`
Expected: FAIL — `history.lastOutgoingAuthor is not a function`

- [ ] **Step 3: Реализация**

В `backend/services/agent/history.js` после функции `hasAgentEverWritten` добавить:

```js
// Автор ПОСЛЕДНЕГО исходящего в диалоге: 'agent' | 'operator' | 'system' | null
// (null — исходящих нет вовсе либо authored_by не проставлен).
//
// ЗАЧЕМ: детерминированные ветки оркестратора (оценка визита «5», короткое «+»
// на акцию — спека 2026-08-10-agent-prompt-to-code-offload) включаются ТОЛЬКО
// когда последнее слово клиники — автоуведомление (authored_by='system'):
// пациент отвечает на отбивку, а не на вопрос Милы. Её вопрос сделал бы
// последним исходящим 'agent', и ветка не сработает — ход уйдёт в LLM.
async function lastOutgoingAuthor(salonId, dialogKey) {
  const row = await db.oneOrNone(
    `SELECT authored_by FROM chatpush_messages
      WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2 AND direction = 'outgoing'
      ORDER BY ${MSG_TS_SQL} DESC, id DESC
      LIMIT 1`,
    [salonId, dialogKey]);
  return (row && row.authored_by) || null;
}
```

И добавить `lastOutgoingAuthor` в `module.exports`.

- [ ] **Step 4: Тест зелёный**

Run: `npx jest agent-history`
Expected: PASS (весь сьют, не только новый describe)

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/history.js backend/agent-history.test.js docs/superpowers/specs/2026-08-10-agent-prompt-to-code-offload.md docs/superpowers/plans/2026-08-10-agent-prompt-to-code-offload.md
git commit -m "feat(agent): history.lastOutgoingAuthor — автор последнего исходящего

Опора для детерминированных веток «оценка визита» и «+ на акцию»
(спека 2026-08-10-agent-prompt-to-code-offload).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: чистый модуль `visit-rating.js`

**Files:**
- Create: `backend/services/agent/visit-rating.js`
- Test: `backend/agent-visit-rating.test.js`

- [ ] **Step 1: Написать падающие тесты**

Создать `backend/agent-visit-rating.test.js`:

```js
'use strict';

const { detectRating, parseRating, buildThanks, buildApology } =
  require('./services/agent/visit-rating');

describe('parseRating', () => {
  test('чистая цифра 2–5', () => {
    expect(parseRating('5')).toBe(5);
    expect(parseRating('2')).toBe(2);
    expect(parseRating(' 4 ')).toBe(4);
  });
  test('цифра с пунктуацией и эмодзи', () => {
    expect(parseRating('5!')).toBe(5);
    expect(parseRating('5)')).toBe(5);
    expect(parseRating('5 ❤️')).toBe(5);
    expect(parseRating('⭐ 5')).toBe(5);
  });
  test('метка времени транскрипта срезается', () => {
    expect(parseRating('[10.08 09:09] 5')).toBe(5);
  });
  test('НЕ оценка: цифра вне 2–5, слова рядом, несколько цифр', () => {
    expect(parseRating('1')).toBe(null);
    expect(parseRating('6')).toBe(null);
    expect(parseRating('5 отлично')).toBe(null);
    expect(parseRating('5 из 5')).toBe(null);
    expect(parseRating('запишите на 5')).toBe(null);
    expect(parseRating('55')).toBe(null);
    expect(parseRating('')).toBe(null);
  });
});

describe('detectRating', () => {
  test('последний блок — user с чистой цифрой → рейтинг', () => {
    const messages = [
      { role: 'assistant', content: '[09.08 12:00] Записала вас' },
      { role: 'user', content: '[10.08 09:09] 5' },
    ];
    expect(detectRating(messages)).toBe(5);
  });
  test('серия из нескольких строк с цифрой И словами → null (пусть решает LLM)', () => {
    expect(detectRating([{ role: 'user', content: '[10.08 09:09] 5\n[10.08 09:10] и запишите ещё' }])).toBe(null);
  });
  test('последний блок не user → null', () => {
    expect(detectRating([{ role: 'user', content: '5' }, { role: 'assistant', content: 'ок' }])).toBe(null);
    expect(detectRating([])).toBe(null);
    expect(detectRating(null)).toBe(null);
  });
});

describe('тексты ответов', () => {
  test('благодарность: с именем и без, без вопросов', () => {
    expect(buildThanks({ givenName: 'Марина' })).toMatch(/^Марина, /);
    expect(buildThanks({})).toMatch(/[Сс]пасибо/);
    expect(buildThanks({})).not.toContain('?');
    // Имя проходит sanitizeName: телефон вместо имени → ветка без имени.
    expect(buildThanks({ givenName: '+79001112233' })).not.toContain('7900');
  });
  test('извинение всегда содержит «администратор» (диспетчер не дошлёт вторую фразу перевода)', () => {
    expect(buildApology({ adminOff: false })).toMatch(/администратор/i);
    expect(buildApology({ adminOff: true })).toMatch(/администратор/i);
    // Ночью не обещаем «в ближайшее время» — как handoverText в admin-hours.
    expect(buildApology({ adminOff: true })).toMatch(/рабочего дня/i);
    expect(buildApology({ adminOff: false })).not.toMatch(/рабочего дня/i);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx jest agent-visit-rating`
Expected: FAIL — `Cannot find module './services/agent/visit-rating'`

- [ ] **Step 3: Реализация**

Создать `backend/services/agent/visit-rating.js`:

```js
'use strict';

// ── Оценка визита («5» в ответ на автоопрос) без LLM-вызова. Чистый модуль. ──
//
// ЗАЧЕМ: инцидент 2026-08-10 (79776646672) — пациентка прислала «5» на опрос
// «оцените обслуживание цифрой от 2 до 5», а Мила поздоровалась и спросила «чем
// могу помочь?». Правило промпта «ОЦЕНКА ВИЗИТА» закрывает смешанные случаи, но
// на ЧИСТОЙ цифре ход предрешён — платить за проход провайдера не за чем (тот же
// класс, что closing.js). Правило в промпте остаётся: «5, и запишите ещё…»,
// выключенный флаг AGENT_VISIT_RATING_REPLY.
//
// Вторая половина условия (последнее исходящее — authored_by='system') живёт в
// оркестраторе через history.lastOutgoingAuthor: пациент отвечает на отбивку
// клиники, а не на вопрос Милы (её вопрос сделал бы последним исходящим 'agent').
const { stripAllStamps } = require('./transcript-time');
const { sanitizeName } = require('./sanitize');

// Цифра 2–5 и НИЧЕГО содержательного рядом: эмодзи и пунктуация срезаются,
// любое слово или вторая цифра делают сообщение ответом для LLM. Границы 2–5 —
// из текста самого опроса YClients («цифрой от 2 до 5»).
function parseRating(text) {
  const s = stripAllStamps(String(text || ''))
    .replace(/\p{Extended_Pictographic}|️/gu, ' ')
    .replace(/[!.,()+\s]+/g, ' ')
    .trim();
  return /^[2-5]$/.test(s) ? Number(s) : null;
}

// messages — транскрипт в формате history.loadTranscript (серии склеены).
// Проверяется ВЕСЬ последний user-блок целиком: строка «5» внутри серии со
// словами — не чистая оценка, её ведёт LLM по правилу промпта.
function detectRating(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1];
  if (!last || last.role !== 'user') return null;
  return parseRating(last.content);
}

// Благодарность за 4–5: без вопросов, без продаж, без «чем могу помочь» —
// разговор закончен (правило «ОЦЕНКА ВИЗИТА»). Имя — через тот же sanitizeName,
// что промпт и greeting.js (в боевых карточках вместо имени бывают телефоны).
function buildThanks(opts = {}) {
  const name = sanitizeName(opts.givenName);
  return `${name ? `${name}, с` : 'С'}пасибо за высокую оценку! Очень рады, что вам всё понравилось. Будем ждать вас снова 🤍`;
}

// Извинение за 2–3 + объявление перевода. Слово «администратор» ОБЯЗАТЕЛЬНО:
// диспетчер по нему понимает, что перевод уже объявлен, и не шлёт вторую
// стандартную фразу (dispatcher.js: announced = /администратор/i).
// adminOff — вне окна присутствия администратора не обещаем скорый ответ
// (та же логика, что admin-hours.handoverText).
function buildApology(opts = {}) {
  const tail = opts.adminOff
    ? 'Передаю ваш диалог администратору клиники — он увидит ваше сообщение и свяжется с вами в начале рабочего дня.'
    : 'Передаю ваш диалог администратору клиники — он свяжется с вами лично, чтобы разобраться.';
  return `Нам очень жаль, что визит вас расстроил — простите нас, пожалуйста. ${tail}`;
}

module.exports = { parseRating, detectRating, buildThanks, buildApology };
```

- [ ] **Step 4: Тесты зелёные**

Run: `npx jest agent-visit-rating`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/visit-rating.js backend/agent-visit-rating.test.js
git commit -m "feat(agent): visit-rating — чистый модуль оценки визита (цифра 2–5)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: интеграция оценки визита в оркестратор + флаг

**Files:**
- Modify: `backend/config.js` (~строка 123, рядом с `AGENT_CLOSING_SILENCE`)
- Modify: `backend/services/agent/orchestrator.js` (импорты ~строка 14; ветка после closing-проверки, после ~строки 499)
- Test: `backend/agent-orchestrator.test.js` (в конец файла)

- [ ] **Step 1: Написать падающие тесты**

В конец `backend/agent-orchestrator.test.js` добавить (харнес `makeDeps` уже в файле; `history`-оверрайды мержатся со стабами):

```js
// ── Оценка визита без LLM (спека 2026-08-10-agent-prompt-to-code-offload) ──
describe('оценка визита («5» на автоопрос)', () => {
  function ratingDeps(rating, lastAuthor, extra = {}) {
    return makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [{ role: 'user', content: String(rating) }], watermark: 500 })),
        lastOutgoingAuthor: jest.fn(async () => lastAuthor),
      },
      ...extra,
    });
  }

  test('«5» после автоуведомления → благодарность, провайдер НЕ вызывается, ватермарк сдвинут', async () => {
    const deps = ratingDeps(5, 'system');
    const res = await orchestrator.runDialog(1, '79001112233', { deps });
    expect(deps.provider.createMessage).not.toHaveBeenCalled();
    expect(res.replies.join(' ')).toMatch(/спасибо/i);
    expect(res.escalated).toBe(false);
    expect(deps.state.setWatermark).toHaveBeenCalledWith(1, '79001112233', 500);
  });

  test('«2» после автоуведомления → извинение + эскалация без LLM', async () => {
    const deps = ratingDeps(2, 'system');
    const res = await orchestrator.runDialog(1, '79001112233', { deps });
    expect(deps.provider.createMessage).not.toHaveBeenCalled();
    expect(deps.registry.handlers.escalate_to_operator).toHaveBeenCalledWith(
      1, { reason: expect.stringContaining('низкая оценка') }, expect.any(Object));
    expect(res.escalated).toBe(true);
    expect(res.replies.join(' ')).toMatch(/администратор/i);
  });

  test('последнее исходящее — agent (Мила задавала вопрос) → ветка не срабатывает, ход в LLM', async () => {
    const deps = ratingDeps(5, 'agent');
    deps.provider.createMessage.mockResolvedValue(
      { assistantMsg: { role: 'assistant', content: 'ок' }, toolCalls: [], text: 'Отвечаю по делу' });
    const res = await orchestrator.runDialog(1, '79001112233', { deps });
    expect(deps.provider.createMessage).toHaveBeenCalled();
    expect(res.replies).toEqual(['Отвечаю по делу']);
  });

  test('сбой lastOutgoingAuthor → fail-open в LLM', async () => {
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({ messages: [{ role: 'user', content: '5' }], watermark: 500 })),
        lastOutgoingAuthor: jest.fn(async () => { throw new Error('db down'); }),
      },
    });
    deps.provider.createMessage.mockResolvedValue(
      { assistantMsg: { role: 'assistant', content: 'ок' }, toolCalls: [], text: 'Ответ' });
    const res = await orchestrator.runDialog(1, 'k', { deps });
    expect(res.replies).toEqual(['Ответ']);
  });

  test('инжектор history без lastOutgoingAuthor → ветка молча пропускается (совместимость)', async () => {
    const deps = makeDeps({
      history: { loadTranscript: jest.fn(async () => ({ messages: [{ role: 'user', content: '5' }], watermark: 500 })) },
    });
    deps.provider.createMessage.mockResolvedValue(
      { assistantMsg: { role: 'assistant', content: 'ок' }, toolCalls: [], text: 'Ответ' });
    const res = await orchestrator.runDialog(1, 'k', { deps });
    expect(res.replies).toEqual(['Ответ']);
  });

  test('AGENT_VISIT_RATING_REPLY=false → ветка выключена', async () => {
    const deps = ratingDeps(5, 'system');
    deps.config = { ...require('./config'), AGENT_VISIT_RATING_REPLY: false };
    deps.provider.createMessage.mockResolvedValue(
      { assistantMsg: { role: 'assistant', content: 'ок' }, toolCalls: [], text: 'Ответ' });
    const res = await orchestrator.runDialog(1, 'k', { deps });
    expect(res.replies).toEqual(['Ответ']);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx jest agent-orchestrator -t "оценка визита"`
Expected: FAIL (провайдер вызывается там, где не должен / нет благодарности)

- [ ] **Step 3: Флаг в config.js**

В `backend/config.js` после блока `AGENT_CLOSING_SILENCE` (строка ~123) добавить:

```js
  // Оценка визита («5» на автоопрос) детерминированной веткой без LLM.
  // По умолчанию ВКЛЮЧЕНО; аварийный рычаг — AGENT_VISIT_RATING_REPLY=false +
  // рестарт: чистая цифра снова уйдёт в LLM по правилу промпта «ОЦЕНКА ВИЗИТА».
  AGENT_VISIT_RATING_REPLY: process.env.AGENT_VISIT_RATING_REPLY !== 'false',
```

- [ ] **Step 4: Ветка в оркестраторе**

В `backend/services/agent/orchestrator.js`:

1. К импортам (рядом с `const closing = require('./closing');`):

```js
const visitRating = require('./visit-rating');
```

2. Сразу ПОСЛЕ блока closing-проверки (`if (cfg.AGENT_CLOSING_SILENCE && closing.shouldStaySilent(messages)) {…}`, до создания `evBuffer`) вставить:

```js
    // Оценка визита: последний блок — ЧИСТАЯ цифра 2–5 И последнее исходящее
    // диалога — автоуведомление (authored_by='system'). Ход предрешён, LLM не
    // нужен (спека 2026-08-10-agent-prompt-to-code-offload). Правило промпта
    // «ОЦЕНКА ВИЗИТА» остаётся для смешанных ответов и выключенного флага.
    // Fail-open: сбой/отсутствие lastOutgoingAuthor → ветка молчит, ход в LLM.
    if (cfg.AGENT_VISIT_RATING_REPLY
        && typeof history.lastOutgoingAuthor === 'function') {
      const rating = visitRating.detectRating(messages);
      if (rating != null) {
        let lastAuthor = null;
        try { lastAuthor = await history.lastOutgoingAuthor(salonId, dialogKey); }
        catch (e) {
          logger.warn(`dialog ${dialogKey}: авторство последнего исходящего не прочитать (${e.message}) — оценку обработает LLM`);
        }
        if (lastAuthor === 'system') {
          await state.setWatermark(salonId, dialogKey, watermark);
          if (rating >= 4) {
            logger.info(`dialog ${dialogKey}: оценка визита ${rating} — детерминированная благодарность без LLM`);
            return { replies: [visitRating.buildThanks({ givenName: clientGivenName })],
              escalated: false, sideEffect: false, ratingReply: true };
          }
          logger.info(`dialog ${dialogKey}: оценка визита ${rating} — извинение и перевод на администратора без LLM`);
          // Эскалация тем же хендлером, что у модели: upsert agent_dialogs +
          // emitAgentStatus + красная подсветка в «Чате». Сбой записи не должен
          // съесть извинение — диспетчер увидит escalated и допереведёт.
          try {
            await registry.handlers['escalate_to_operator'](salonId,
              { reason: `низкая оценка визита (${rating})` }, toolCtx);
          } catch (e) {
            logger.warn(`dialog ${dialogKey}: эскалация по низкой оценке не записалась (${e.message})`);
          }
          return { replies: [visitRating.buildApology({ adminOff: promptOpts.adminOffHours })],
            escalated: true, sideEffect: true, ratingReply: true };
        }
      }
    }
```

- [ ] **Step 5: Тесты зелёные, соседние сьюты не задеты**

Run: `npx jest agent-orchestrator agent-dispatcher agent-closing`
Expected: PASS (все 116+ прежних тестов оркестратора зелёные: в их транскриптах нет чистой цифры, у стаба history нет lastOutgoingAuthor — ветка молчит)

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add backend/config.js backend/services/agent/orchestrator.js backend/agent-orchestrator.test.js
git commit -m "feat(agent): оценка визита «5» — детерминированный ответ без LLM-прохода

Чистая цифра 2–5 после автоуведомления: 4–5 → благодарность, 2–3 →
извинение + эскалация. Условие — lastOutgoingAuthor='system'. Флаг
AGENT_VISIT_RATING_REPLY (default on). Инцидент 2026-08-10 (79776646672).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: чистый модуль `promo-interest.js`

**Files:**
- Create: `backend/services/agent/promo-interest.js`
- Test: `backend/agent-promo-interest.test.js`

- [ ] **Step 1: Написать падающие тесты**

Создать `backend/agent-promo-interest.test.js`:

```js
'use strict';

const { isPromoInterest } = require('./services/agent/promo-interest');

describe('isPromoInterest', () => {
  const userMsg = (content) => [{ role: 'user', content }];

  test('голый «+» и «плюс» — триггер', () => {
    expect(isPromoInterest(userMsg('+'))).toBe(true);
    expect(isPromoInterest(userMsg('++'))).toBe(true);
    expect(isPromoInterest(userMsg('Плюс'))).toBe(true);
    expect(isPromoInterest(userMsg('[10.08 09:09] +'))).toBe(true);
    expect(isPromoInterest(userMsg('+ 🙏'))).toBe(true);
  });

  test('НЕ триггер: содержательный текст, «да», пусто, не-user', () => {
    expect(isPromoInterest(userMsg('да'))).toBe(false);          // «да» — согласие на что угодно
    expect(isPromoInterest(userMsg('расскажите'))).toBe(false);  // узкий триггер намеренно
    expect(isPromoInterest(userMsg('+ запишите меня'))).toBe(false);
    expect(isPromoInterest(userMsg('79001112233'))).toBe(false);
    expect(isPromoInterest([{ role: 'assistant', content: '+' }])).toBe(false);
    expect(isPromoInterest([])).toBe(false);
    expect(isPromoInterest(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx jest agent-promo-interest`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: Реализация**

Создать `backend/services/agent/promo-interest.js`:

```js
'use strict';

// ── Короткое согласие на сообщение об акции («+»). Чистый модуль. ────────────
//
// ЗАЧЕМ: правило промпта «СПЕЦПРЕДЛОЖЕНИЕ МЕСЯЦА» требует от модели вызвать
// search_knowledge_base — это ДВА прохода провайдера по ~39k-промпту. Оркестратор
// по этому предикату делает вызов КБ САМ до первого прохода и кладёт статью в
// хвост промпта (спека 2026-08-10-agent-prompt-to-code-offload).
//
// Триггер намеренно УЖЕ промпт-правила: только «+»/«плюс». «Да», «расскажите»,
// «интересно» не триггерят — их пусть разбирает модель (это может быть согласие
// на предложенный слот; вторая половина условия — «последнее исходящее =
// автоуведомление» — проверяется в оркестраторе через history.lastOutgoingAuthor).
const { stripAllStamps } = require('./transcript-time');

function isPromoInterest(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1];
  if (!last || last.role !== 'user') return false;
  const s = stripAllStamps(String(last.content || ''))
    .replace(/\p{Extended_Pictographic}|️/gu, ' ')
    .replace(/[!.\s]+/g, ' ')
    .trim();
  return /^(?:\+{1,3}|плюс)$/i.test(s);
}

module.exports = { isPromoInterest };
```

- [ ] **Step 4: Тесты зелёные**

Run: `npx jest agent-promo-interest`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/promo-interest.js backend/agent-promo-interest.test.js
git commit -m "feat(agent): promo-interest — предикат короткого «+» на акцию

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: блок статьи об акции в системном промпте

**Files:**
- Modify: `backend/services/agent/system-prompt.js` (opts ~строка 154; правка правила «СПЕЦПРЕДЛОЖЕНИЕ МЕСЯЦА» ~строка 352; рендер блока в самом конце массива, после `leadingClinic`)
- Test: `backend/agent-system-prompt.test.js` (в конец файла)

- [ ] **Step 1: Написать падающие тесты**

В конец `backend/agent-system-prompt.test.js` добавить (функция `buildSystemPrompt` в файле уже импортирована — проверить имя переменной в шапке файла и использовать её):

```js
// ── Блок статьи об акции (предвызов КБ на «+», спека 2026-08-10) ──
describe('блок «СТАТЬЯ О СПЕЦПРЕДЛОЖЕНИИ МЕСЯЦА»', () => {
  test('promoBlock рендерится в самом хвосте, промпт без блока — префикс промпта с блоком', () => {
    const base = buildSystemPrompt({});
    const withPromo = buildSystemPrompt({ promoBlock: 'Акция августа: скидка 20% на чистки' });
    expect(withPromo.startsWith(base)).toBe(true);          // инвариант префикс-кэша
    expect(withPromo).toContain('СТАТЬЯ О СПЕЦПРЕДЛОЖЕНИИ МЕСЯЦА');
    expect(withPromo).toContain('скидка 20% на чистки');
    expect(withPromo).toMatch(/Повторно вызывать search_knowledge_base не нужно/);
  });
  test('пустой/не-строковый promoBlock → блока нет', () => {
    expect(buildSystemPrompt({ promoBlock: '  ' })).not.toContain('СТАТЬЯ О СПЕЦПРЕДЛОЖЕНИИ');
    expect(buildSystemPrompt({ promoBlock: 42 })).not.toContain('СТАТЬЯ О СПЕЦПРЕДЛОЖЕНИИ');
  });
  test('правило «СПЕЦПРЕДЛОЖЕНИЕ МЕСЯЦА» знает про готовый блок', () => {
    expect(buildSystemPrompt({})).toMatch(/Если в конце промпта уже есть блок «СТАТЬЯ О СПЕЦПРЕДЛОЖЕНИИ МЕСЯЦА»/);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx jest agent-system-prompt -t "СТАТЬЯ О СПЕЦПРЕДЛОЖЕНИИ"`
Expected: FAIL

- [ ] **Step 3: Реализация**

В `backend/services/agent/system-prompt.js`:

1. В `buildSystemPrompt` рядом с разбором `leadingClinic` (~строка 154) добавить:

```js
  // Статья об акции, найденная ПРЕДВЫЗОВОМ КБ (оркестратор, promo-interest):
  // пациент ответил «+» на автоотбивку об акции — статья уже найдена кодом,
  // и модели не нужен собственный вызов search_knowledge_base (−1 проход
  // провайдера). Кап 4000 символов; построчная санитизация — как leadingClinic.
  const promoBlock = typeof opts.promoBlock === 'string' && opts.promoBlock.trim()
    ? opts.promoBlock.trim().slice(0, 4000) : null;
```

2. В правило «СПЕЦПРЕДЛОЖЕНИЕ МЕСЯЦА», в строку `ЧТО ДЕЛАТЬ: …` (строка ~352) — заменить строку целиком на:

```js
    `ЧТО ДЕЛАТЬ: Если в конце промпта уже есть блок «СТАТЬЯ О СПЕЦПРЕДЛОЖЕНИИ МЕСЯЦА» — статья уже найдена: отвечай по ней и search_knowledge_base НЕ вызывай. Иначе ОБЯЗАТЕЛЬНО вызови search_knowledge_base с запросом «спецпредложение месяца, акция» (если название акции прозвучало в переписке — добавь его в запрос) и расскажи о предложении ТОЛЬКО тем, что нашлось в статье: суть, условия, срок действия, на какие процедуры распространяется.`,
```

3. В САМЫЙ конец возвращаемого массива (после спреда `leadingClinic`, перед `].join('\n')`) добавить:

```js
    // Статья об акции из предвызова КБ — САМЫЙ последний блок: дописывается в
    // хвост, чтобы промпт без него оставался ПРЕФИКСОМ промпта с ним (кэш).
    ...(promoBlock ? [
      ``,
      `СТАТЬЯ О СПЕЦПРЕДЛОЖЕНИИ МЕСЯЦА (найдена автоматически: пациент коротко согласился на сообщение об акции):`,
      ...promoBlock.split('\n').map(l => sanitizeLine(l, 400)).filter(Boolean),
      `Расскажи о предложении по правилу «СПЕЦПРЕДЛОЖЕНИЕ МЕСЯЦА» — ТОЛЬКО тем, что есть в этой статье. Повторно вызывать search_knowledge_base не нужно.`,
    ] : []),
```

- [ ] **Step 4: Тесты зелёные (весь сьют промпта)**

Run: `npx jest agent-system-prompt`
Expected: PASS. Если какой-то прежний тест цитировал старую строку «ЧТО ДЕЛАТЬ: ОБЯЗАТЕЛЬНО вызови…» — обновить ассерт под новую формулировку, сохранив смысловую проверку (обязательность вызова при отсутствии блока).

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js
git commit -m "feat(agent): хвостовой блок статьи об акции + правка правила спецпредложения

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: предвызов КБ в оркестраторе

**Files:**
- Modify: `backend/config.js` (рядом с `AGENT_VISIT_RATING_REPLY`)
- Modify: `backend/services/agent/orchestrator.js` (импорт; переменные перед циклом попыток ~строка 477; блок после создания `evBuffer` ~строка 510; `promoBlock` в вызов `buildSystemPrompt`; `kbSourceText`)
- Test: `backend/agent-orchestrator.test.js`

- [ ] **Step 1: Написать падающие тесты**

В конец `backend/agent-orchestrator.test.js`:

```js
// ── Предвызов КБ на «+» (спека 2026-08-10-agent-prompt-to-code-offload) ──
describe('предвызов КБ на короткое «+»', () => {
  function promoDeps(lastAuthor, kbResult) {
    const kbHandler = jest.fn(async () => kbResult);
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({ messages: [{ role: 'user', content: '+' }], watermark: 500 })),
        lastOutgoingAuthor: jest.fn(async () => lastAuthor),
      },
      handlers: { search_knowledge_base: kbHandler },
    });
    deps.provider.createMessage.mockResolvedValue(
      { assistantMsg: { role: 'assistant', content: 'ок' }, toolCalls: [], text: 'Расскажу про акцию' });
    return { deps, kbHandler };
  }

  test('«+» после автоуведомления → КБ вызвана кодом, статья в системном промпте', async () => {
    const { deps, kbHandler } = promoDeps('system',
      { found: true, context: 'Акция августа: скидка 20% на чистки', sources: [] });
    await orchestrator.runDialog(1, '79001112233', { deps });
    expect(kbHandler).toHaveBeenCalledWith(1, { query: 'спецпредложение месяца, акция' }, expect.any(Object));
    const system = deps.provider.createMessage.mock.calls[0][0].system;
    expect(system).toContain('СТАТЬЯ О СПЕЦПРЕДЛОЖЕНИИ МЕСЯЦА');
    expect(system).toContain('скидка 20% на чистки');
  });

  test('статья не нашлась → блока нет, ход штатный', async () => {
    const { deps } = promoDeps('system', { found: false, context: '', sources: [] });
    await orchestrator.runDialog(1, '79001112233', { deps });
    const system = deps.provider.createMessage.mock.calls[0][0].system;
    expect(system).not.toContain('СТАТЬЯ О СПЕЦПРЕДЛОЖЕНИИ МЕСЯЦА');
  });

  test('последнее исходящее — agent («+» может быть согласием на слот) → предвызова нет', async () => {
    const { deps, kbHandler } = promoDeps('agent', { found: true, context: 'x', sources: [] });
    await orchestrator.runDialog(1, '79001112233', { deps });
    expect(kbHandler).not.toHaveBeenCalled();
  });

  test('предвызов пишется в журнал tool-событий (память следующего хода)', async () => {
    const stub = makeToolEventsStub();
    const { deps } = promoDeps('system', { found: true, context: 'Акция', sources: [] });
    deps.toolEvents = stub.mod;
    await orchestrator.runDialog(1, '79001112233', { deps });
    const pushed = stub.buffers[0].push.mock.calls.map(c => c[0]);
    expect(pushed).toContain('search_knowledge_base');
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx jest agent-orchestrator -t "предвызов КБ"`
Expected: FAIL

- [ ] **Step 3: Флаг**

В `backend/config.js` после `AGENT_VISIT_RATING_REPLY`:

```js
  // Предвызов базы знаний на короткое «+» (согласие на отбивку об акции):
  // статью ищет код, экономя один полный проход провайдера. Рычаг —
  // AGENT_PROMO_PREFETCH=false + рестарт (модель вызовет КБ сама, как раньше).
  AGENT_PROMO_PREFETCH: process.env.AGENT_PROMO_PREFETCH !== 'false',
```

- [ ] **Step 4: Оркестратор**

В `backend/services/agent/orchestrator.js`:

1. Импорт: `const promoInterest = require('./promo-interest');`

2. Перед циклом `for (let attempt = 0; …)` (~строка 477) добавить:

```js
  // Предвызов КБ на короткое «+» (акция): делается ОДИН раз на ход и переживает
  // перегенерации (статья не протухает за секунды прогона).
  const PROMO_QUERY = { query: 'спецпредложение месяца, акция' };
  let promoKb = null;
  let promoChecked = false;
```

3. Внутри цикла, СРАЗУ после `bag.buf = evBuffer;` вставить:

```js
    // «+» на отбивку об акции → search_knowledge_base зовёт КОД, а не модель:
    // правило промпта требовало от неё вызова, т.е. второго полного прохода
    // провайдера (спека 2026-08-10). Условие то же двухчастное, что у оценки
    // визита: триггер-предикат + последнее исходящее — автоуведомление.
    // Fail-open: любой сбой → блока нет, модель вызовет КБ сама, как раньше.
    if (cfg.AGENT_PROMO_PREFETCH && !promoChecked) {
      promoChecked = true;
      if (promoInterest.isPromoInterest(messages)
          && typeof history.lastOutgoingAuthor === 'function') {
        try {
          const author = await history.lastOutgoingAuthor(salonId, dialogKey);
          if (author === 'system' && registry.handlers['search_knowledge_base']) {
            const kb = await registry.handlers['search_knowledge_base'](salonId, PROMO_QUERY, toolCtx);
            if (kb && kb.found && kb.context) promoKb = kb;
            logger.info(`dialog ${dialogKey}: короткое «+» на акцию — предвызов базы знаний (${promoKb ? 'статья найдена' : 'статьи нет'})`);
          }
        } catch (e) {
          logger.warn(`dialog ${dialogKey}: предвызов базы знаний не удался (${e.message}) — модель вызовет сама`);
        }
      }
    }
    // В журнал — на КАЖДОЙ попытке: буфер пересоздаётся, а вердикт delivered
    // ставится тому буферу, чья попытка реально вернулась.
    if (promoKb) evBuffer.push('search_knowledge_base', PROMO_QUERY, promoKb, false);
```

4. В вызов `buildSystemPrompt` добавить поле:

```js
    const system = buildSystemPrompt({
      ...promptOpts, session, firstContact, firstAgentReply, leadingClinic,
      promoBlock: promoKb ? promoKb.context : null,
    });
```

5. Инициализацию `let kbSourceText = '';` заменить на:

```js
    // Предзагруженная статья — легальный источник этого хода и для address-guard
    // (иначе адрес из статьи об акции вырезался бы как выдумка).
    let kbSourceText = promoKb ? JSON.stringify(promoKb) : '';
```

- [ ] **Step 5: Тесты зелёные**

Run: `npx jest agent-orchestrator agent-system-prompt`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add backend/config.js backend/services/agent/orchestrator.js backend/agent-orchestrator.test.js
git commit -m "feat(agent): предвызов КБ на «+» — минус один проход провайдера

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: маскировка цены «Ботулакс 1 ед» в каталоге

**Files:**
- Modify: `backend/services/agent/catalog-block.js`
- Test: `backend/agent-catalog-block.test.js` (в конец)

- [ ] **Step 1: Написать падающий тест**

В конец `backend/agent-catalog-block.test.js` (проверить в шапке файла, что `renderCatalogBlock` импортирован — он уже используется):

```js
// ── Цена единицы Ботулакса не должна попадать в промпт (спека 2026-08-10) ──
describe('маскировка цены «Ботулинотерапия Ботулакс 1 ед»', () => {
  test('цена и цены мастеров рендерятся как «инд.»/только id — числа в блоке нет', () => {
    const b = renderCatalogBlock([
      { yc_id: 1, title: 'Ботулинотерапия  Ботулакс 1 ед ( 30 минут )', duration_min: 30,
        price_min: 370, price_max: 370,
        category_path: ['Инъекционная косметология', 'Ботулинотерапия'],
        staff: [{ yc_id: 5, name: 'Пери', price_min: 370, price_max: 370 },
                { yc_id: 6, name: 'Астемир', price_min: 500, price_max: 500 }] },
    ]);
    const line = b.split('\n').find(l => l.startsWith('1|'));
    expect(line).toContain('|инд.|');
    expect(line.endsWith('|5,6')).toBe(true);   // мастера без «=цена»
    expect(b).not.toContain('370');
    expect(b).not.toContain('500');
  });
  test('обычная услуга не задета', () => {
    const b = renderCatalogBlock([
      { yc_id: 2, title: 'Чистка лица', duration_min: 60, price_min: 5000, price_max: 5000,
        category_path: ['Уходы'], staff: [{ yc_id: 5, name: 'Юлия', price_min: 5000, price_max: 5000 }] },
    ]);
    expect(b.split('\n').find(l => l.startsWith('2|'))).toContain('|5000|');
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx jest agent-catalog-block -t Ботулакс`
Expected: FAIL (в строке `370`)

- [ ] **Step 3: Реализация**

В `backend/services/agent/catalog-block.js`:

1. Импорт после `loadCatalogServices`:

```js
const { matchesGenericTitle } = require('./catalog-data');
```

2. После константы `PLACEHOLDER_PRICE_MAX` добавить:

```js
// «Ботулинотерапия Ботулакс 1 ед» — цена за ОДНУ ЕДИНИЦУ препарата (370 ₽), а не
// за процедуру; промпт запрещает называть её пациенту и включать в диапазоны.
// Тот же приём, что с заглушкой 1 ₽: рендерим «инд.» и мастеров без цен — модель
// физически не видит числа, и правило перестаёт держаться на одном промпте
// (спека 2026-08-10-agent-prompt-to-code-offload).
const UNIT_PRICE_TITLE = 'Ботулинотерапия Ботулакс 1 ед';
const isUnitPriceService = (title) => matchesGenericTitle(title, UNIT_PRICE_TITLE);
```

3. `fmtStaffCell` — добавить второй аргумент:

```js
function fmtStaffCell(staff, opts = {}) {
  const list = (staff || []).slice().sort((a, b) => a.yc_id - b.yc_id);
  if (!list.length) return '';
  if (opts.hidePrices) return list.map(m => String(m.yc_id)).join(',');
  const prices = list.map(m => fmtPrice(m.price_min, m.price_max));
  const same = prices.every(p => p === prices[0]);
  return list.map((m, i) => (same ? String(m.yc_id) : `${m.yc_id}=${prices[i]}`)).join(',');
}
```

4. В `renderCatalogBlock`, в маппинг `lines`, заменить сборку строки:

```js
  const lines = sorted
    .map(s => {
      const unitPrice = isUnitPriceService(s.title);
      return [
        s.yc_id,
        cell(s.title, 120),
        s.duration_min || '',
        unitPrice ? 'инд.' : fmtPrice(s.price_min, s.price_max),
        (s.category_path || []).map(c => cell(c, 60)).join('>'),
        fmtStaffCell(s.staff, { hidePrices: unitPrice }),
      ].join('|');
    });
```

- [ ] **Step 4: Тесты зелёные**

Run: `npx jest agent-catalog-block agent-system-prompt`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/catalog-block.js backend/agent-catalog-block.test.js
git commit -m "fix(agent): цена единицы Ботулакса замаскирована в каталоге промпта

Запрет «не называть цену за 1 ед» держался только на промпте, а 370 ₽
стояло в каталоге открытым текстом. Тот же приём, что с заглушкой 1 ₽.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: блок «ДИАПАЗОНЫ ЦЕН» в каталоге

**Files:**
- Modify: `backend/services/agent/catalog-block.js`
- Test: `backend/agent-catalog-block.test.js` (в конец)

- [ ] **Step 1: Написать падающие тесты**

В конец `backend/agent-catalog-block.test.js`:

```js
// ── Предрассчитанные диапазоны цен направлений (спека 2026-08-10) ──
describe('блок «ДИАПАЗОНЫ ЦЕН»', () => {
  const staffOf = (lo, hi) => [{ yc_id: 5, name: 'А', price_min: lo, price_max: hi }];
  const services = [
    { yc_id: 1, title: 'Биоревитализация Revi Silk 1 ml', price_min: 12000, price_max: 12000,
      category_path: ['Инъекционная косметология', 'Биоревитализация'], staff: staffOf(12000, 12000) },
    { yc_id: 2, title: 'Биоревитализация Profhilo', price_min: 18000, price_max: 21000,
      category_path: ['Инъекционная косметология', 'Биоревитализация'], staff: staffOf(18000, 21000) },
    // Обобщённая заглушка (1 ₽ → «инд.») — в диапазон не входит.
    { yc_id: 3, title: 'Биоревитализация', price_min: 1, price_max: 0,
      category_path: ['Инъекционная косметология', 'Биоревитализация'], staff: staffOf(1, 0) },
    // Единица Ботулакса — не входит (Task 7 маскирует в «инд.»).
    { yc_id: 4, title: 'Ботулинотерапия  Ботулакс 1 ед ( 30 минут )', price_min: 370, price_max: 370,
      category_path: ['Инъекционная косметология', 'Ботулинотерапия'], staff: staffOf(370, 370) },
    // Мужская услуга — отдельный прайс узла.
    { yc_id: 5, title: 'Муж. Комплекс 5в1', price_min: 24700, price_max: 24700,
      category_path: ['Инъекционная косметология', 'Ботулинотерапия'], staff: staffOf(24700, 24700) },
  ];

  test('диапазон узла: женские без «инд.», мужские отдельно, узлы обоих уровней', () => {
    const b = renderCatalogBlock(services);
    expect(b).toContain('ДИАПАЗОНЫ ЦЕН');
    expect(b).toContain('- «Биоревитализация»: от 12000 до 21000 ₽');
    expect(b).toContain('- «Инъекционная косметология»: от 12000 до 21000 ₽ (мужской прайс «Муж.»: 24700 ₽)');
    expect(b).toContain('- «Ботулинотерапия»: только мужской прайс «Муж.» — 24700 ₽');
  });

  test('детерминизм: перестановка входа не меняет блок байт-в-байт', () => {
    const a = renderCatalogBlock(services);
    const b = renderCatalogBlock(services.slice().reverse());
    expect(a).toBe(b);
  });

  test('услуг с ценами нет → блока диапазонов нет', () => {
    const b = renderCatalogBlock([
      { yc_id: 9, title: 'X', price_min: null, price_max: null, category_path: ['Y'], staff: staffOf(null, null) },
    ]);
    expect(b).not.toContain('ДИАПАЗОНЫ ЦЕН');
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx jest agent-catalog-block -t ДИАПАЗОНЫ`
Expected: FAIL

- [ ] **Step 3: Реализация**

В `backend/services/agent/catalog-block.js`:

1. Импорт: `const { isMaleService } = require('./male-services');`

2. Перед `renderCatalogBlock` добавить:

```js
// ── Предрассчитанные диапазоны цен по узлам category_path ────────────────────
// ЗАЧЕМ: правило «Цена НАПРАВЛЕНИЯ» заставляло МОДЕЛЬ отбирать услуги по
// category_path, исключать «инд.» и считать min/max — чистую арифметику, которую
// LLM делает хуже кода. Готовые числа лежат прямо в кэшируемом блоке каталога.
// Исключаются услуги без цены и с ценой «инд.» (заглушки ≤100 ₽, «Ботулакс 1 ед»
// после маскировки Task 7); мужской прайс («Муж.») считается ОТДЕЛЬНО — смешивать
// прайсы запрещает правило «МУЖСКОЙ ПРАЙС».
function fmtRange(r) {
  return r.lo === r.hi ? `${r.lo} ₽` : `от ${r.lo} до ${r.hi} ₽`;
}

const RANGES_HEADER =
  'ДИАПАЗОНЫ ЦЕН ПО НАПРАВЛЕНИЯМ И ГРУППАМ УСЛУГ (посчитано по каталогу выше; услуги «инд.» и цена единицы препарата в диапазоны не входят). Отвечая на вопрос о цене направления или группы, называй диапазон ОТСЮДА — сама услуги не суммируй и не пересчитывай. Женский и мужской прайс разделены:';

function renderPriceRanges(services) {
  const nodes = new Map();   // имя узла → { f:{lo,hi}|null, m:{lo,hi}|null }
  for (const s of services || []) {
    if (isUnitPriceService(s.title)) continue;
    const priceCell = fmtPrice(s.price_min, s.price_max);
    if (!priceCell || priceCell === 'инд.') continue;
    const lo = Number(s.price_min) || 0;
    const hi = Math.max(lo, Number(s.price_max) || 0);
    const key = isMaleService(s.title) ? 'm' : 'f';
    for (const raw of (s.category_path || [])) {
      const name = cell(raw, 60);
      if (!name) continue;
      const node = nodes.get(name) || { f: null, m: null };
      const cur = node[key];
      node[key] = cur
        ? { lo: Math.min(cur.lo, lo), hi: Math.max(cur.hi, hi) }
        : { lo, hi };
      nodes.set(name, node);
    }
  }
  // Простое строковое сравнение, НЕ localeCompare: блок обязан быть
  // детерминированным байт-в-байт (префикс-кэш), а localeCompare зависит от ICU.
  return [...nodes.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, { f, m }]) => {
      if (f && m) return `- «${name}»: ${fmtRange(f)} (мужской прайс «Муж.»: ${fmtRange(m)})`;
      if (f) return `- «${name}»: ${fmtRange(f)}`;
      return `- «${name}»: только мужской прайс «Муж.» — ${fmtRange(m)}`;
    });
}
```

3. В `renderCatalogBlock`, в сборку `block`, после `...lines` добавить:

```js
  const rangeLines = renderPriceRanges(sorted);
  const block = [
    'КАТАЛОГ УСЛУГ КЛИНИКИ (…прежняя шапка без изменений…)',
    legend ? `Мастера: ${legend}` : null,
    ...lines,
    ...(rangeLines.length ? ['', RANGES_HEADER, ...rangeLines] : []),
  ].filter(Boolean).join('\n');
```

(шапку-строку не менять — только вставить `rangeLines` между `...lines` и `].filter(...)`).

4. В `module.exports` добавить `renderPriceRanges` (ради прямых юнит-тестов при желании).

- [ ] **Step 4: Тесты зелёные**

Run: `npx jest agent-catalog-block`
Expected: PASS (включая старый тест детерминизма)

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/catalog-block.js backend/agent-catalog-block.test.js
git commit -m "feat(agent): предрассчитанные диапазоны цен направлений в каталоге промпта

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: правка правила «Цена НАПРАВЛЕНИЯ» (catalogMode) на готовый блок

**Files:**
- Modify: `backend/services/agent/system-prompt.js` (строка ~267, ТОЛЬКО catalogMode-ветка)
- Test: `backend/agent-system-prompt.test.js`

- [ ] **Step 1: Написать падающий тест**

В конец `backend/agent-system-prompt.test.js`:

```js
describe('цена направления — из готового блока «ДИАПАЗОНЫ ЦЕН» (спека 2026-08-10)', () => {
  test('catalogMode-правило отсылает к блоку и запрещает пересчёт', () => {
    const p = buildSystemPrompt({ catalogBlock: 'КАТАЛОГ УСЛУГ КЛИНИКИ\n1|X|30|100|Y|5' });
    expect(p).toMatch(/готовый диапазон .* в блоке «ДИАПАЗОНЫ ЦЕН»/i);
    expect(p).toMatch(/Цена НАПРАВЛЕНИЯ \(пациент спрашивает стоимость целого направления/i);
  });
  test('legacy-режим (без каталога) не тронут', () => {
    const p = buildSystemPrompt({});
    expect(p).not.toMatch(/ДИАПАЗОНЫ ЦЕН/);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx jest agent-system-prompt -t "ДИАПАЗОНЫ ЦЕН"`
Expected: FAIL

- [ ] **Step 3: Реализация**

В `backend/services/agent/system-prompt.js` заменить catalogMode-ветку правила «Цена НАПРАВЛЕНИЯ» (строка ~267) на:

```js
    catalogMode
      ? `- Цена НАПРАВЛЕНИЯ (пациент спрашивает стоимость целого направления: «сколько стоит биоревитализация?», «какие цены на эпиляцию?»): НИКОГДА не перечисляй все услуги/препараты/зоны с ценами и НИКОГДА не пересчитывай диапазон сама — готовый диапазон каждого направления и группы уже посчитан в блоке «ДИАПАЗОНЫ ЦЕН» сразу под каталогом: назови его оттуда «от {минимальная} до {максимальная} ₽», выбрав женский или мужской прайс по полу пациента (правило «МУЖСКОЙ ПРАЙС»). Если направления в блоке нет — назови диапазон по услугам направления через category_path, не включая услуги с ценой «инд.». Если верхней границы нет — просто «от {минимальная} ₽». Слово «от» без верхней границы уместно ТОЛЬКО здесь, где конкретная услуга ещё не выбрана.`
      : `…legacy-строка БЕЗ ИЗМЕНЕНИЙ (не трогать)…`,
```

(legacy-ветку оставить байт-в-байт как была.)

- [ ] **Step 4: Прогнать весь сьют промпта и починить цитирующие ассерты**

Run: `npx jest agent-system-prompt`
Expected: возможно FAIL в тестах, цитирующих старую формулировку catalogMode-ветки (например «услуги с ценой «инд.» в подсчёт диапазона не включай»). Обновить эти ассерты под новую формулировку, сохранив смысловые проверки: (а) запрет перечисления услуг с ценами, (б) исключение «инд.», (в) «от» без верхней границы только здесь. Тест 167 (`Цена НАПРАВЛЕНИЯ (пациент спрашивает…`) должен пройти без правок.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js
git commit -m "fix(agent): правило цены направления отсылает к готовому блоку диапазонов

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 10: чистый модуль `generic-booking-guard.js`

**Files:**
- Create: `backend/services/agent/generic-booking-guard.js`
- Test: `backend/agent-generic-booking-guard.test.js`

- [ ] **Step 1: Написать падающие тесты**

Создать `backend/agent-generic-booking-guard.test.js`:

```js
'use strict';

const { check } = require('./services/agent/generic-booking-guard');

const CATALOG = [
  { yc_id: 99, title: 'Биоревитализация', category_path: ['Инъекционная косметология', 'Биоревитализация'] },
  { yc_id: 10, title: 'Биоревитализация Revi Silk 1 ml', category_path: ['Инъекционная косметология', 'Биоревитализация'] },
];

describe('generic-booking-guard.check', () => {
  test('конкретный препарат, которого пациент не называл → нарушение с id обобщённой услуги', () => {
    const v = check({
      title: 'Биоревитализация Revi Silk 1 ml',
      categoryPath: ['Инъекционная косметология', 'Биоревитализация'],
      patientText: 'хочу биоревитализацию на завтра',
      services: CATALOG,
    });
    expect(v).toEqual({ genericTitle: 'Биоревитализация', genericYcId: 99, brands: ['revi', 'silk'] });
  });

  test('пациент называл бренд (в любом регистре) → нарушения нет', () => {
    expect(check({
      title: 'Биоревитализация Revi Silk 1 ml',
      categoryPath: ['Инъекционная косметология', 'Биоревитализация'],
      patientText: 'запишите на REVI silk пожалуйста',
      services: CATALOG,
    })).toBe(null);
  });

  test('сама обобщённая услуга → нарушения нет', () => {
    expect(check({
      title: 'Биоревитализация',
      categoryPath: ['Инъекционная косметология', 'Биоревитализация'],
      patientText: 'хочу био',
      services: CATALOG,
    })).toBe(null);
  });

  test('направление не охраняется (ботулинотерапия/зоны, чистки) → нарушения нет', () => {
    expect(check({
      title: 'Лоб+Межбровье',
      categoryPath: ['Инъекционная косметология', 'Ботулинотерапия'],
      patientText: 'ботокс',
      services: CATALOG,
    })).toBe(null);
  });

  test('в названии нет латинского бренда → судить не по чему, нарушения нет', () => {
    expect(check({
      title: 'Биоревитализация классическая',
      categoryPath: ['Инъекционная косметология', 'Биоревитализация'],
      patientText: 'хочу био',
      services: CATALOG,
    })).toBe(null);
  });

  test('обобщённой услуги нет в каталоге → правило невыполнимо, нарушения нет (fail-open)', () => {
    expect(check({
      title: 'Биоревитализация Revi Silk 1 ml',
      categoryPath: ['Инъекционная косметология', 'Биоревитализация'],
      patientText: 'хочу био',
      services: [CATALOG[1]],
    })).toBe(null);
  });

  test('пустой patientText → нарушения нет (сверять не с чем)', () => {
    expect(check({
      title: 'Биоревитализация Revi Silk 1 ml',
      categoryPath: ['Инъекционная косметология', 'Биоревитализация'],
      patientText: '',
      services: CATALOG,
    })).toBe(null);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx jest agent-generic-booking-guard`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: Реализация**

Создать `backend/services/agent/generic-booking-guard.js`:

```js
'use strict';

// ── Запись на конкретный препарат, которого пациент не называл. Чистый модуль. ──
//
// Инцидент 2026-07-31: пациент попросил «биоревитализацию», модель молча оформила
// «Revi Silk 1 ml» — правило промпта «ПРЕПАРАТ/ФИЛЛЕР НЕ УТОЧНЯЕМ» требует в этом
// случае обобщённую услугу (препарат подбирает врач очно). Держалось только на
// промпте; теперь create_booking переспрашивает детерминированно (hint-ответ, как
// too_soon), обход — явный patient_named_service:true.
//
// Охраняются ТОЛЬКО «препаратные» направления и ТОЛЬКО по ЛАТИНСКИМ брендовым
// токенам (Revi, Stylage, Profhilo…): зоны ботулинотерапии — русские слова со
// склонением («лба» при услуге «Лоб+Межбровье»), стем-сверка давала бы ложные
// срабатывания на самом частом легальном пути, а каждое ложное — лишний проход
// провайдера. Пациент, назвавший бренд кириллицей («стилаж»), — тоже ложное
// срабатывание, на него и есть обход patient_named_service.
const { matchesGenericTitle } = require('./catalog-data');

const GUARDED_GENERICS = ['Биоревитализация', 'Увеличение губ', 'Контурная пластика'];

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();

// Латинские токены названия — маркер конкретного препарата. ≥3 букв: «ml», «gr»
// и прочие единицы измерения отсеиваются длиной.
function brandTokens(title) {
  return (String(title || '').match(/[A-Za-z]{3,}/g) || []).map(t => t.toLowerCase());
}

// → null (нарушения нет) либо { genericTitle, genericYcId, brands }.
function check({ title, categoryPath, patientText, services } = {}) {
  if (!patientText) return null;   // сверять не с чем — не судим
  const path = (categoryPath || []).map(norm);
  const genericTitle = GUARDED_GENERICS.find(g => path.includes(norm(g)));
  if (!genericTitle) return null;
  if (matchesGenericTitle(title, genericTitle)) return null;   // сама обобщённая
  const brands = brandTokens(title);
  if (!brands.length) return null;                             // без бренда не судим
  const hay = norm(patientText);
  if (brands.some(b => hay.includes(b))) return null;          // пациент называл
  const generic = (services || []).find(s => matchesGenericTitle(s.title, genericTitle));
  if (!generic) return null;   // обобщённой услуги нет в каталоге — правило невыполнимо
  return { genericTitle, genericYcId: generic.yc_id, brands };
}

module.exports = { check, GUARDED_GENERICS };
```

- [ ] **Step 4: Тесты зелёные**

Run: `npx jest agent-generic-booking-guard`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/generic-booking-guard.js backend/agent-generic-booking-guard.test.js
git commit -m "feat(agent): generic-booking-guard — чистый модуль (инцидент Revi Silk 31.07)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 11: интеграция guard'а в create_booking + `toolCtx.patientText`

**Files:**
- Modify: `backend/services/agent/tools/create-booking.js` (схема + проверка после `staffOk`)
- Modify: `backend/services/agent/orchestrator.js` (одна строка после вычисления `patientText`, ~строка 597)
- Test: `backend/agent-create-booking-generic.test.js` (новый)

- [ ] **Step 1: Написать падающие тесты**

Создать `backend/agent-create-booking-generic.test.js`:

```js
'use strict';

// Интеграция generic-booking-guard в create_booking. Все внешние зависимости
// инструмента застаблены — тест проверяет ровно порядок гейтов и hint-ответ.
jest.mock('./services/agent/booking', () => ({
  createBookingRecord: jest.fn(async () => ({ created: true, record_id: 777 })),
}));
jest.mock('./services/agent/tools/list-services', () => ({ run: jest.fn() }));
jest.mock('./services/agent-settings', () => ({ loadServiceFilterSafe: jest.fn(async () => null) }));
jest.mock('./services/agent/service-filter', () => ({ isBookable: () => true }));

const booking = require('./services/agent/booking');
const listServices = require('./services/agent/tools/list-services');
const tool = require('./services/agent/tools/create-booking');

beforeEach(() => jest.clearAllMocks());

const CATALOG = { services: [
  { yc_id: 99, title: 'Биоревитализация', category_path: ['Инъекционная косметология', 'Биоревитализация'],
    staff: [{ yc_id: 5, name: 'Пери' }] },
  { yc_id: 10, title: 'Биоревитализация Revi Silk 1 ml', category_path: ['Инъекционная косметология', 'Биоревитализация'],
    staff: [{ yc_id: 5, name: 'Пери' }] },
] };

// nowMs фиксирован, слот заведомо за пределами lead-time (правило «впритык»).
const CTX = { clientPhone: '79001112233', dialogKey: '79001112233',
  nowMs: Date.parse('2026-08-10T10:00:00+03:00'), patientText: 'хочу биоревитализацию' };
const INPUT = { staff_yc_id: 5, service_yc_id: 10, datetime: '2026-08-14T15:00:00+03:00' };

describe('create_booking × generic-booking-guard', () => {
  test('препарат не назван пациентом → hint без записи, с id обобщённой услуги', async () => {
    listServices.run.mockResolvedValue(CATALOG);
    const res = await tool.run(1, INPUT, CTX);
    expect(res.generic_service_hint).toBe(true);
    expect(res.error).toContain('service_yc_id=99');
    expect(res.error).toContain('patient_named_service');
    expect(booking.createBookingRecord).not.toHaveBeenCalled();
  });

  test('пациент называл бренд → запись проходит', async () => {
    listServices.run.mockResolvedValue(CATALOG);
    const res = await tool.run(1, INPUT, { ...CTX, patientText: 'хочу Revi Silk' });
    expect(res.created).toBe(true);
    expect(booking.createBookingRecord).toHaveBeenCalled();
  });

  test('обход patient_named_service:true → запись проходит', async () => {
    listServices.run.mockResolvedValue(CATALOG);
    const res = await tool.run(1, { ...INPUT, patient_named_service: true }, CTX);
    expect(res.created).toBe(true);
  });

  test('без patientText в ctx (например book_chain) → guard молчит', async () => {
    listServices.run.mockResolvedValue(CATALOG);
    const { patientText, ...ctx } = CTX;
    const res = await tool.run(1, INPUT, ctx);
    expect(res.created).toBe(true);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx jest agent-create-booking-generic`
Expected: FAIL (первый тест: created:true вместо hint)

- [ ] **Step 3: Реализация**

В `backend/services/agent/tools/create-booking.js`:

1. Импорт: `const genericGuard = require('../generic-booking-guard');`

2. В `input_schema.properties` добавить:

```js
      patient_named_service: { type: 'boolean', description: 'Ставь true, ТОЛЬКО если пациент ' +
        'САМ явно назвал этот конкретный препарат/филлер в переписке (в том числе своими словами ' +
        'или кириллицей). Без явного упоминания пациентом — не ставь.' },
```

3. Внутри блока `if (catalog && Array.isArray(catalog.services) && …)`, СРАЗУ после проверки `staffOk` (после её `return`), добавить:

```js
    // Обобщённая услуга по умолчанию (правило «ПРЕПАРАТ/ФИЛЛЕР НЕ УТОЧНЯЕМ»,
    // инцидент 2026-07-31 «Revi Silk» вместо «Биоревитализации»): запись на
    // конкретный препарат, латинского названия которого нет в сообщениях
    // пациента, детерминированно переспрашивается — hint-ответ, как too_soon.
    if (!input.patient_named_service) {
      const g = genericGuard.check({
        title: svc.title, categoryPath: svc.category_path,
        patientText: ctx.patientText, services: catalog.services,
      });
      if (g) {
        return {
          generic_service_hint: true,
          error: `Пациент не называл препарат (${g.brands.join(' ')}). По правилу «ПРЕПАРАТ/ФИЛЛЕР НЕ УТОЧНЯЕМ» ` +
            `оформляй обобщённую услугу «${g.genericTitle}» (service_yc_id=${g.genericYcId}) — препарат подберёт врач на визите. ` +
            'Если пациент явно называл именно этот препарат своими словами — повтори вызов с patient_named_service:true.',
        };
      }
    }
```

В `backend/services/agent/orchestrator.js`, сразу после вычисления `patientText` (строка `const patientAskedOtherTime = …`, ~597) добавить:

```js
    // Текст сообщений пациента → generic-booking-guard в create_booking
    // (сверка «называл ли пациент препарат»). Пересчитывается каждой попыткой,
    // как attachments: перегенерация видит свежую серию.
    toolCtx.patientText = patientText;
```

- [ ] **Step 4: Тесты зелёные + не сломаны прежние тесты записи**

Run: `npx jest agent-create-booking-generic agent-booking agent-book-chain agent-orchestrator`
Expected: PASS (book_chain не передаёт patientText → guard там молчит по построению)

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/tools/create-booking.js backend/services/agent/orchestrator.js backend/agent-create-booking-generic.test.js
git commit -m "feat(agent): create_booking переспрашивает запись на неназванный препарат

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 12: `title-dedup.js` — должность один раз за диалог

**Files:**
- Create: `backend/services/agent/title-dedup.js`
- Modify: `backend/services/agent/orchestrator.js` (вычисление `priorAssistantText` рядом с `patientText`; вызов после цикла `stripStamp`, ~строка 901)
- Test: `backend/agent-title-dedup.test.js` (новый) + `backend/agent-orchestrator.test.js`

- [ ] **Step 1: Написать падающие тесты модуля**

Создать `backend/agent-title-dedup.test.js`:

```js
'use strict';

const { stripRepeatedTitles, namesWithTitle } = require('./services/agent/title-dedup');

describe('namesWithTitle', () => {
  test('собирает стемы имён, у которых должность уже звучала', () => {
    const seen = namesWithTitle('Вас примет косметолог-эстетист Юлия в 12:00. Главный врач Пери Исамудиновна ведёт приём.');
    expect(seen.has('Юлия'.slice(0, 4))).toBe(true);
    expect(seen.has('Пери')).toBe(true);
  });
  test('пусто на тексте без пар', () => {
    expect(namesWithTitle('Здравствуйте! Чем могу помочь?').size).toBe(0);
  });
});

describe('stripRepeatedTitles', () => {
  const prior = 'Завтра свободна косметолог-эстетист Юлия.';

  test('повтор должности срезается, имя с падежом остаётся', () => {
    const { replies, stripped } = stripRepeatedTitles(
      ['Записала вас к косметологу-эстетисту Юлии на 12:00.'], prior);
    expect(replies).toEqual(['Записала вас к Юлии на 12:00.']);
    expect(stripped).toHaveLength(1);
  });

  test('первое упоминание ДРУГОГО специалиста не трогается', () => {
    const { replies, stripped } = stripRepeatedTitles(
      ['Эту процедуру ведёт главный врач Пери Исамудиновна.'], prior);
    expect(replies).toEqual(['Эту процедуру ведёт главный врач Пери Исамудиновна.']);
    expect(stripped).toHaveLength(0);
  });

  test('прошлых пар нет → реплики нетронуты', () => {
    const { replies } = stripRepeatedTitles(['косметолог-эстетист Юлия свободна'], 'Добрый день!');
    expect(replies).toEqual(['косметолог-эстетист Юлия свободна']);
  });

  test('склонение должности тоже ловится в прошлом тексте', () => {
    const { replies } = stripRepeatedTitles(
      ['Вас ждёт косметолог-эстетист Юлия.'],
      'Я записала вас к косметологу-эстетисту Юлии.');
    expect(replies).toEqual(['Вас ждёт Юлия.']);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx jest agent-title-dedup`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: Реализация модуля**

Создать `backend/services/agent/title-dedup.js`:

```js
'use strict';

// ── «ДОЛЖНОСТЬ НАЗЫВАЙ ОДИН РАЗ ЗА ДИАЛОГ» — детерминированная дочистка. ─────
// Чистый модуль: ни БД, ни HTTP.
//
// Правило промпта: должность специалиста звучит при ПЕРВОМ упоминании, дальше —
// только имя («косметолог-эстетист Юлия… у косметолога-эстетиста Юлии…» подряд
// звучит казённо). Держалось только на промпте. Замена безопасна текстуально:
// в русской конструкции «должность + Имя» падеж несёт ИМЯ, поэтому срез
// должности («у косметолога-эстетиста Юлии» → «у Юлии») оставляет фразу
// грамматичной. Первое упоминание в ТЕКУЩЕЙ реплике не трогается — срезаются
// только имена, чья должность уже звучала в ПРОШЛЫХ репликах Милы.
//
// Должности — паттерны со склонением (списком, а не «любое слово перед именем»).
// «наш специалист» намеренно не в списке: это не должность, а оборот речи.
const POSITION_SRC =
  '(?:главн[а-яё]+\\s+врач[а-яё]*|врач[а-яё]*-косметолог[а-яё]*|косметолог[а-яё]*-эстетист[а-яё]*)';
// Пара «должность[,] Имя [Отчество]» — имя капитализировано, 1–2 слова.
const PAIR_RE = new RegExp(
  `${POSITION_SRC},?\\s+(\\p{Lu}\\p{Ll}+(?:\\s+\\p{Lu}\\p{Ll}+)?)`, 'giu');

// Имя в переписке склоняется («Юлия» / «к Юлии») — сверка по стему, тот же
// приём, что mentionsPerson в reply-guard.
const MIN_STEM = 4;
const stemOf = (word) => word.slice(0, Math.max(MIN_STEM, word.length - 2));

// Стемы имён, у которых должность уже звучала в прошлом тексте Милы.
function namesWithTitle(priorAssistantText) {
  const out = new Set();
  for (const m of String(priorAssistantText || '').matchAll(PAIR_RE)) {
    out.add(stemOf(m[1].split(/\s+/)[0]));
  }
  return out;
}

// → { replies, stripped } — stripped идёт в лог оркестратора.
function stripRepeatedTitles(replies, priorAssistantText) {
  const list = Array.isArray(replies) ? replies : [];
  const seen = namesWithTitle(priorAssistantText);
  if (!seen.size) return { replies: list, stripped: [] };
  const stripped = [];
  const out = list.map(text => String(text).replace(PAIR_RE, (full, name) => {
    if (!seen.has(stemOf(name.split(/\s+/)[0]))) return full;
    stripped.push(full.trim());
    return name;
  }));
  return { replies: out, stripped };
}

module.exports = { stripRepeatedTitles, namesWithTitle };
```

- [ ] **Step 4: Тесты модуля зелёные**

Run: `npx jest agent-title-dedup`
Expected: PASS

- [ ] **Step 5: Интеграция в оркестратор + тест**

В `backend/services/agent/orchestrator.js`:

1. Импорт: `const titleDedup = require('./title-dedup');`

2. Рядом с вычислением `patientText` (~строка 595) добавить:

```js
    // Прошлые реплики Милы (без реплик администратора и меток времени) — для
    // title-dedup («должность один раз») и телеметрии gift_repeat.
    const priorAssistantText = stripAllStamps(messages
      .filter(m => m.role === 'assistant')
      .map(m => m.content.split('\n')
        .filter(l => !l.includes(historyDefault.OPERATOR_MARK)).join('\n'))
      .join('\n'));
```

3. После цикла `for (let i = 0; i < replies.length; i++) replies[i] = stripStamp(replies[i]);` (~строка 901), ПЕРЕД address-guard, добавить:

```js
    // Должность специалиста — один раз за диалог: повтор срезается
    // детерминированно (имя несёт падеж, фраза остаётся грамматичной; правило
    // «ДОЛЖНОСТЬ НАЗЫВАЙ ОДИН РАЗ» промпт выполняет нестабильно).
    {
      const titled = titleDedup.stripRepeatedTitles(replies, priorAssistantText);
      if (titled.stripped.length) {
        logger.info(`dialog ${dialogKey}: повтор должности срезан: ${JSON.stringify(titled.stripped)}`);
        replies.length = 0;
        replies.push(...titled.replies);
      }
    }
```

4. Интеграционный тест в `backend/agent-orchestrator.test.js`:

```js
// ── Повтор должности срезается детерминированно (спека 2026-08-10) ──
test('повтор должности из прошлой реплики Милы срезается в новой', async () => {
  const deps = makeDeps({
    history: {
      loadTranscript: jest.fn(async () => ({
        messages: [
          { role: 'user', content: 'кто свободен завтра?' },
          { role: 'assistant', content: 'Завтра свободна косметолог-эстетист Юлия.' },
          { role: 'user', content: 'запишите к ней' },
        ],
        watermark: 500,
      })),
    },
  });
  deps.provider.createMessage.mockResolvedValue({
    assistantMsg: { role: 'assistant', content: 'ок' }, toolCalls: [],
    text: 'Записала вас к косметологу-эстетисту Юлии.' });
  const res = await orchestrator.runDialog(1, 'k', { deps });
  expect(res.replies).toEqual(['Записала вас к Юлии.']);
});
```

ВНИМАНИЕ: этот текст содержит «Записала» без write-инструмента — falseSuccess его погасит? Нет: `detectFalseClaim` ловит `записал[аи]? вас` в BOOKED_STATE_CLAIM, а `claimProof.existsHonest` false → `falseSuccess=true` и replies уйдут с флагом. Чтобы тест проверял ровно title-dedup, заменить текст реплики на нейтральный:

```js
    text: 'Завтра вас примет косметолог-эстетист Юлия в 12:00.' });
  const res = await orchestrator.runDialog(1, 'k', { deps });
  expect(res.replies).toEqual(['Завтра вас примет Юлия в 12:00.']);
```

(время 12:00 в allowedTimes попадает из транскрипта? НЕТ — в транскрипте его нет, unknown_time жёсткий и запустит довызов. Убрать время вовсе:)

```js
    text: 'Вас примет косметолог-эстетист Юлия, всё передала.' });
  const res = await orchestrator.runDialog(1, 'k', { deps });
  expect(res.replies).toEqual(['Вас примет Юлия, всё передала.']);
```

Использовать ПОСЛЕДНИЙ вариант (без времён и без утверждений о записи).

- [ ] **Step 6: Тесты зелёные**

Run: `npx jest agent-title-dedup agent-orchestrator`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/title-dedup.js backend/agent-title-dedup.test.js backend/services/agent/orchestrator.js backend/agent-orchestrator.test.js
git commit -m "feat(agent): должность специалиста один раз за диалог — детерминированный срез повтора

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 13: телеметрия `gift_repeat` в reply-guard

**Files:**
- Modify: `backend/services/agent/reply-guard.js`
- Modify: `backend/services/agent/orchestrator.js` (одна строка в списке violations)
- Test: `backend/agent-reply-guard.test.js` (в конец)

- [ ] **Step 1: Написать падающие тесты**

В конец `backend/agent-reply-guard.test.js` (в шапке файла проверить импорт и добавить `checkGiftRepeat, GIFT_RE` в деструктуризацию из reply-guard):

```js
// ── gift_repeat: «консультация в подарок» второй раз за диалог (лог-only) ──
describe('checkGiftRepeat', () => {
  test('повтор при уже звучавшем «в подарок» → нарушение', () => {
    expect(checkGiftRepeat('Плюс консультация в подарок!', { priorHasGift: true }))
      .toEqual([{ type: 'gift_repeat', value: 'в подарок' }]);
  });
  test('первое упоминание → чисто', () => {
    expect(checkGiftRepeat('Консультация в подарок при процедуре в тот же день', { priorHasGift: false })).toEqual([]);
  });
  test('нет фразы в реплике → чисто', () => {
    expect(checkGiftRepeat('Записала вас на чистку', { priorHasGift: true })).toEqual([]);
  });
  test('gift_repeat — НЕ жёсткое нарушение (только лог)', () => {
    expect(hardViolations([{ type: 'gift_repeat', value: 'в подарок' }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx jest agent-reply-guard -t gift_repeat`
Expected: FAIL

- [ ] **Step 3: Реализация**

В `backend/services/agent/reply-guard.js` перед `HARD_TYPES` добавить:

```js
// «Консультация в подарок» — один раз за диалог (правило Сценария 2). ТОЛЬКО
// измерение, как offer_bypass: резать текст с упоминанием подарка рискованно
// (фраза вплетена в предложение), а масштаб проблемы неизвестен — сначала лог.
// priorHasGift считает оркестратор по прошлым репликам Милы (без реплик
// администратора).
const GIFT_RE = /в\s+подарок/i;
function checkGiftRepeat(text, opts = {}) {
  if (!opts.priorHasGift) return [];
  return GIFT_RE.test(String(text || ''))
    ? [{ type: 'gift_repeat', value: 'в подарок' }] : [];
}
```

И добавить `checkGiftRepeat, GIFT_RE` в `module.exports`.

В `backend/services/agent/orchestrator.js`, в массив `violations` (после `checkStaffAttribution`) добавить:

```js
        // «Консультация в подарок» один раз за диалог — только измерение.
        ...replyGuard.checkGiftRepeat(joined,
          { priorHasGift: replyGuard.GIFT_RE.test(priorAssistantText) }),
```

- [ ] **Step 4: Тесты зелёные**

Run: `npx jest agent-reply-guard agent-orchestrator`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/reply-guard.js backend/services/agent/orchestrator.js backend/agent-reply-guard.test.js
git commit -m "feat(agent): телеметрия gift_repeat — повтор «консультации в подарок»

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 14: полный прогон, документация

**Files:**
- Modify: `CLAUDE.md` (раздел «AI-агент: управление и гейт допуска»)

- [ ] **Step 1: Полный прогон тестов**

Run: `cd /root/loyalpro/backend && npx jest --testPathIgnorePatterns=primary-clients.test.js`
Expected: PASS (все сьюты; при падениях в НЕ тронутых файлах — сверить с памятью о флейке; падения в тронутых — чинить до зелёного)

- [ ] **Step 2: Дописать CLAUDE.md**

В раздел «AI-агент: управление и гейт допуска» добавить пункты (в стиле существующих, кратко):

```markdown
- Оценка визита («5» на автоопрос) отвечается БЕЗ LLM (`services/agent/visit-rating.js`, тесты `agent-visit-rating.test.js`; флаг `AGENT_VISIT_RATING_REPLY`, default on): чистая цифра 2–5 при последнем исходящем `authored_by='system'` (новый `history.lastOutgoingAuthor`) — 4–5 шаблонная благодарность, 2–3 извинение + эскалация тем же хендлером `escalate_to_operator`. Смешанные ответы («5, и запишите…») по-прежнему ведёт LLM по правилу «ОЦЕНКА ВИЗИТА». Fail-open: сбой проверки авторства → ход в LLM.
- Короткое «+» на отбивку об акции: `search_knowledge_base` зовёт ОРКЕСТРАТОР (`promo-interest.js`, флаг `AGENT_PROMO_PREFETCH`), статья уезжает хвостовым блоком «СТАТЬЯ О СПЕЦПРЕДЛОЖЕНИИ МЕСЯЦА» — минус один полный проход провайдера; вызов пишется в журнал tool-событий и в `kbSourceText` (address-guard). Триггер намеренно уже правила: только «+»/«плюс» при последнем исходящем `system`.
- Диапазоны цен направлений ПРЕДРАССЧИТАНЫ в блоке каталога (`renderPriceRanges` в `catalog-block.js`): по каждому узлу category_path, женский/мужской прайс раздельно, «инд.» и «Ботулакс 1 ед» исключены; правило «Цена НАПРАВЛЕНИЯ» (catalogMode) отсылает к блоку. Цена «Ботулакс 1 ед» в каталоге замаскирована в «инд.» (мастера без цен) — модель числа 370 не видит вовсе.
- Запись на конкретный препарат, которого пациент не называл (`generic-booking-guard.js` + hint в `create_booking`): направления Биоревитализация/Увеличение губ/Контурная пластика, сверка ЛАТИНСКИХ брендовых токенов названия с `toolCtx.patientText`; обход — `patient_named_service:true`. Зоны ботулинотерапии намеренно не охраняются (склонение «лба»/«Лоб» дало бы ложные срабатывания). book_chain не покрыт (ctx без patientText → guard молчит).
- Повтор должности специалиста срезается детерминированно (`title-dedup.js`, после stripStamp до address-guard): пара «должность+Имя», уже звучавшая в прошлых репликах Милы, в новой реплике остаётся одним именем (падеж несёт имя — фраза грамматична). Повтор «консультации в подарок» — только телеметрия `gift_repeat` в reply-guard.
```

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro && git add CLAUDE.md
git commit -m "docs: детерминированные ветки Милы вместо промпт-правил (спека 2026-08-10)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Живой смоук (по возможности, вручную)**

После штатного рестарта дева (`PORT=3001 pm2 restart loyalpro`, НЕ `--update-env`):
- `/clear-history` для тестового номера 79200255591, затем с этого номера прислать «5» после любого системного исходящего — в `pm2 logs loyalpro` ожидать строку `оценка визита 5 — детерминированная благодарность без LLM`.
- Спросить у Милы «сколько стоит биоревитализация?» — ответ должен совпасть с диапазоном из блока (проверить лог: вызовов get_service_masters/пересчёта не требуется).
- Прогнать `scripts/agent-price-probe.js` (синтетические номера, чистит за собой) — цены мастеров не регрессировали.

---

## Self-Review (выполнен при написании)

- Покрытие спеки: W1 → Tasks 1–3; W2 → Tasks 4–6; W3 (5а/5б/5в) → Tasks 7–9; W4 → Tasks 10–11; W5 → Task 12; W6 → Task 13; флаги → Tasks 3/6; документация → Task 14. Раздел «НЕ входит» задач не требует.
- Типы/сигнатуры сквозные: `lastOutgoingAuthor(salonId, dialogKey)` (Tasks 1, 3, 6); `detectRating(messages)`/`buildThanks({givenName})`/`buildApology({adminOff})` (Tasks 2–3); `isPromoInterest(messages)` (4, 6); `buildSystemPrompt({promoBlock})` (5, 6); `fmtStaffCell(staff, {hidePrices})`, `renderPriceRanges(services)` (7, 8); `check({title, categoryPath, patientText, services})` (10, 11); `stripRepeatedTitles(replies, priorAssistantText)` (12); `checkGiftRepeat(text, {priorHasGift})` (13); `priorAssistantText` объявляется в Task 12 и используется в Task 13 — при исполнении Task 13 раньше Task 12 сначала добавить вычисление `priorAssistantText` из Task 12 Step 5.2.
- Известные готчи учтены: инвариант префикс-кэша (promoBlock в самом хвосте, детерминизм ranges без localeCompare), совместимость с 116 тестами оркестратора (typeof-guard на lastOutgoingAuthor), falseSuccess/unknown_time в интеграционном тесте Task 12 (текст без времён и заявлений о записи), «наш специалист» не в POSITION_SRC.
