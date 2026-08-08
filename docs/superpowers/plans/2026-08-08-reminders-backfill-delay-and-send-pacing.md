# Догон по естественной дате визита + темп отправки — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Догон напоминаний ставит строку на дату «визит + `delay_days`», а не на завтра, и воркер выдерживает настраиваемую паузу между сообщениями.

**Architecture:** Две независимые части. (1) В `services/reminders/backfill.js` чистая `spreadOverDays` заменяется на `planBackfillSchedule`, которая считает естественную дату той же `computeScheduledAt`, что и боевой планировщик, и раскладывает по капу ТОЛЬКО просроченные строки. (2) Новый чистый модуль `services/messaging/send-pacing.js` (по образцу соседнего `daily-limit.js`) даёт «сколько ещё ждать», а воркер напоминаний откладывает строку на эти минуты новым `deferRowMinutes` — до платного LLM-вызова и до необратимого начисления бонусов. Интервал живёт в поле правила `send_interval_min`.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`, без ORM), jest, ванильный JS фронт.

**Спека:** `docs/superpowers/specs/2026-08-08-reminders-backfill-delay-and-send-pacing-design.md`

---

## Файлы

| Файл | Ответственность |
|---|---|
| `backend/services/reminders/backfill.js` | Модифицируется: `spreadOverDays` → `planBackfillSchedule` |
| `backend/reminders-backfill.test.js` | Модифицируется: блок тестов `spreadOverDays` → `planBackfillSchedule` |
| `backend/services/messaging/send-pacing.js` | **Создаётся**: `waitMsLeft` (чистая) + `lastPlannedSendAt` (SQL) |
| `backend/messaging-send-pacing.test.js` | **Создаётся**: тесты `waitMsLeft` |
| `backend/migrations.js` | Модифицируется: колонка `send_interval_min` |
| `backend/routes/reminders.js` | Модифицируется: валидация поля, CRUD-SQL, вызовы плана, ответ превью |
| `backend/reminders-routes.test.js` | Модифицируется: валидация `sendIntervalMin` |
| `backend/services/reminders/worker.js` | Модифицируется: колонка в LEASE, `deferRowMinutes`, гейт темпа, `buildTestDeps` |
| `backend/reminders-worker.test.js` | Модифицируется: тесты гейта темпа |
| `frontend/index.html` | Модифицируется: поле «Пауза между сообщениями» + колонка «Отправка» в превью |
| `frontend/js/pages/reminders.js` | Модифицируется: чтение/запись поля, разбивка превью |

Порядок задач: сначала чистая логика догона (1–2), затем поле правила сквозь стек (3), затем темп (4–5), затем UI (6), затем прогон (7).

---

### Task 1: `planBackfillSchedule` — план догона по естественной дате

**Files:**
- Modify: `backend/services/reminders/backfill.js:119-157`
- Test: `backend/reminders-backfill.test.js:112-180` (блок `describe('spreadOverDays')`)

- [ ] **Step 1: Написать падающие тесты**

В `backend/reminders-backfill.test.js` заменить ЦЕЛИКОМ блок `describe('spreadOverDays', () => { … })` (строки 112 до конца файла) на этот. Импорт в шапке файла (строка 6) тоже поменять на `planBackfillSchedule`:

```js
const { matchBackfillVisits, planBackfillSchedule } = require('./services/reminders/backfill');
```

```js
// ── план догона ────────────────────────────────────────────────
// NOW = 2026-08-07 09:00 МСК, то есть send_time 11:00 сегодня ещё впереди.
describe('planBackfillSchedule', () => {
  const DELAY = 60;
  const plan = (rows, over = {}) => planBackfillSchedule(rows, {
    delayDays: DELAY, sendTime: '11:00', maxPerDay: 30, nowMs: NOW, ...over });

  // Естественная дата = визит + delay_days в send_time, ровно как в боевом
  // планировщике (enroll.js). Визит моложе задержки ждёт своей даты.
  test('визит моложе delay_days встаёт на естественную дату, а не на завтра', () => {
    const out = plan([{ recordId: 1, visitAt: '2026-08-01T10:00:00.000Z' }]);
    expect(out).toHaveLength(1);
    expect(out[0].overdue).toBe(false);
    // 01.08 + 60 дней = 30.09, 11:00 МСК = 08:00 UTC
    expect(out[0].scheduledAt.toISOString()).toBe('2026-09-30T08:00:00.000Z');
  });

  test('просроченный визит уходит в догоняющую пачку — сегодня, пока 11:00 не прошло', () => {
    const out = plan([{ recordId: 1, visitAt: '2026-06-01T11:00:00.000Z' }]);
    expect(out[0].overdue).toBe(true);
    expect(out[0].scheduledAt.toISOString()).toBe('2026-08-07T08:00:00.000Z');
  });

  test('если send_time уже прошло — догоняющая пачка стартует завтра', () => {
    const late = Date.parse('2026-08-07T12:00:00+03:00');
    const out = plan([{ recordId: 1, visitAt: '2026-06-01T11:00:00.000Z' }], { nowMs: late });
    expect(out[0].scheduledAt.toISOString()).toBe('2026-08-08T08:00:00.000Z');
  });

  // Кап существует ради всплеска догона — к строкам, стоящим на свою
  // естественную дату, он не применяется: там всплеска нет по построению.
  test('кап режет только просроченных, будущие не трогает', () => {
    const overdue = Array.from({ length: 3 }, (_, i) => (
      { recordId: 100 + i, visitAt: `2026-06-0${i + 1}T11:00:00.000Z` }));
    const future = Array.from({ length: 5 }, (_, i) => (
      { recordId: 200 + i, visitAt: '2026-08-01T10:00:00.000Z' }));
    const out = plan([...future, ...overdue], { maxPerDay: 2 });
    const od = out.filter(r => r.overdue).map(r => r.scheduledAt.toISOString());
    expect(od).toEqual([
      '2026-08-07T08:00:00.000Z',   // 1-й и 2-й — сегодня
      '2026-08-07T08:00:00.000Z',
      '2026-08-08T08:00:00.000Z',   // 3-й переехал на завтра
    ]);
    // Все пять будущих остались на одной дате, кап их не разнёс.
    const fu = out.filter(r => !r.overdue).map(r => r.scheduledAt.toISOString());
    expect(fu).toEqual(Array(5).fill('2026-09-30T08:00:00.000Z'));
  });

  // Решение владельца салона: первым напоминание получает тот, кто НЕ БЫЛ
  // ДОЛЬШЕ ВСЕХ. Это отдельная сортировка от «свежие сверху» в
  // matchBackfillVisits (та нужна только для дедупликации superseded).
  test('просроченные сортируются по дате визита по возрастанию', () => {
    const rows = [
      { recordId: 1, visitAt: '2026-06-20T11:00:00.000Z' },
      { recordId: 2, visitAt: '2026-05-01T11:00:00.000Z' },
      { recordId: 3, visitAt: '2026-06-01T11:00:00.000Z' },
    ];
    const out = plan(rows, { maxPerDay: 1 });
    expect(out.map(r => r.recordId)).toEqual([2, 3, 1]);
  });

  test('строка без даты визита не роняет план и попадает в догоняющую пачку', () => {
    const out = plan([{ recordId: 1, visitAt: null }]);
    expect(out).toHaveLength(1);
    expect(out[0].overdue).toBe(true);
    expect(out[0].scheduledAt).toBeInstanceOf(Date);
  });

  test('пустой вход → пустой план', () => {
    expect(plan([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Прогнать тесты и убедиться, что падают**

Run: `cd /root/loyalpro/backend && npx jest reminders-backfill.test.js`
Expected: FAIL — `planBackfillSchedule is not a function`.

- [ ] **Step 3: Реализовать**

В `backend/services/reminders/backfill.js` заменить блок `spreadOverDays` (строки 119-155) на:

```js
/**
 * План отправок догона.
 *
 * Естественная дата строки = дата визита + delay_days в send_time, и считает
 * её ТА ЖЕ computeScheduledAt, что и боевой событийный планировщик
 * (services/reminders/enroll.js) — вторая копия правила означала бы, что
 * догон и боевой путь молча разъедутся, а догон ровно этим и обещает быть:
 * «что было бы, если бы правило работало».
 *
 * Две корзины:
 *  - естественная дата ЕЩЁ ВПЕРЕДИ (визит моложе задержки) — строка встаёт на
 *    неё, кап НЕ применяется: всплеска тут нет по построению, на каждый день
 *    падает столько строк, сколько в тот день было визитов;
 *  - естественная дата УЖЕ ПРОШЛА (просрочен) — догоняющая пачка: сортировка
 *    по дате визита ПО ВОЗРАСТАНИЮ (решение владельца салона: первым получает
 *    тот, кто не был дольше всех — он самый просроченный по смыслу правила),
 *    раскладка по ближайшим дням пачками по maxPerDay, старт сегодня, если
 *    send_time ещё не прошло, иначе завтра (строка в прошлом ушла бы
 *    немедленно, минуя кап).
 *
 * Строка без разбираемой даты визита попадает в догоняющую пачку: своей даты
 * у неё нет, а терять её молча нельзя.
 *
 * @returns {object[]} те же строки + { scheduledAt: Date|null, overdue: boolean }
 */
function planBackfillSchedule(rows, { delayDays = 0, sendTime = '11:00',
                                      maxPerDay = 30, nowMs = Date.now() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];
  const cap = Math.max(1, Math.floor(Number(maxPerDay) || 1));
  const now = new Date(nowMs);

  const future = [];
  const overdue = [];
  for (const row of list) {
    const natural = computeScheduledAt(row && row.visitAt, delayDays, sendTime);
    if (natural && natural.getTime() > nowMs) future.push({ ...row, scheduledAt: natural, overdue: false });
    else overdue.push(row);
  }

  // Устойчивая и безопасная сортировка: строки без даты не бросают и не
  // переставляются относительно друг друга (Array.prototype.sort в V8
  // стабильна с ES2019).
  overdue.sort((a, b) => {
    const ma = visitMsOf(a);
    const mb = visitMsOf(b);
    if (ma == null && mb == null) return 0;
    if (ma == null) return 1;
    if (mb == null) return -1;
    return ma - mb;
  });

  const today = computeScheduledAt(now, 0, sendTime);
  const startOffset = today && today.getTime() > nowMs ? 0 : 1;
  const caught = overdue.map((row, i) => ({
    ...row,
    scheduledAt: computeScheduledAt(now, startOffset + Math.floor(i / cap), sendTime),
    overdue: true,
  }));

  return [...caught, ...future];
}

module.exports = { matchBackfillVisits, planBackfillSchedule };
```

Строку `module.exports = { matchBackfillVisits, spreadOverDays };` (была последней в файле) удалить — новый экспорт выше её заменяет.

- [ ] **Step 4: Прогнать тесты**

Run: `cd /root/loyalpro/backend && npx jest reminders-backfill.test.js`
Expected: PASS, все тесты файла.

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/reminders/backfill.js backend/reminders-backfill.test.js
git commit -m "feat(reminders): догон считает дату отправки как визит + delay_days

spreadOverDays ставила ВСЕ строки на ближайшие дни от сегодня, игнорируя
delay_days: на правиле с задержкой 60 дней клиент, бывший вчера, получал
напоминание завтра. planBackfillSchedule берёт естественную дату той же
computeScheduledAt, что боевой планировщик, а кап применяет только к
просроченным.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Маршруты догона переходят на новый план

**Files:**
- Modify: `backend/routes/reminders.js:28` (импорт), `:262-278` (превью), `:352-357` (боевой догон)

- [ ] **Step 1: Заменить импорт**

В `backend/routes/reminders.js` строка 28:

```js
const { matchBackfillVisits, planBackfillSchedule } = require('../services/reminders/backfill');
```

- [ ] **Step 2: Переписать обработчик превью**

Заменить тело `router.post('/rules/:id/backfill/preview', …)` целиком на:

```js
router.post('/rules/:id/backfill/preview', guard, async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.body && req.body.days) || 30));
  try {
    const r = await buildBackfill(req.user.salonId, req.params.id, days);
    if (r.error) return res.status(r.code).json({ error: r.error });
    const planned = planBackfillSchedule(r.out.rows.filter(x => !x.skipReason), {
      delayDays: r.rule.delay_days, sendTime: r.rule.send_time,
      maxPerDay: r.rule.backfill_max_per_day }).filter(x => x.scheduledAt);

    // Две корзины показываются администратору РАЗДЕЛЬНО: «просрочено N,
    // уйдут за K дней» и «встанет в очередь на будущее M» — это разные по
    // смыслу вещи, и слипшись в одно число они читаются как «уйдёт N+M
    // сообщений на днях», ровно то заблуждение, из-за которого догон и
    // чинили.
    const overdue = planned.filter(p => p.overdue);
    const maxAt = (arr) => (arr.length
      ? new Date(Math.max(...arr.map(p => p.scheduledAt.getTime())))
      : null);
    // Дата отправки нужна в КАЖДОЙ строке таблицы: без неё администратор не
    // видит, что именно исправилось.
    const whenBy = new Map(planned.map(p => [String(p.recordId), p.scheduledAt]));

    res.json({
      totals: r.out.totals,
      rows: r.out.rows.map(x => ({ ...x, scheduledAt: whenBy.get(String(x.recordId)) || null })),
      days,
      catMapFailed: r.catMapFailed,
      overdueCount: overdue.length,
      futureCount: planned.length - overdue.length,
      lastOverdueAt: maxAt(overdue),
      lastScheduledAt: maxAt(planned),
    });
  } catch (e) {
    log.error(`превью догона правила #${req.params.id}: ${e.message}`);
    res.status(500).json({ error: 'Не удалось построить выборку' });
  }
});
```

- [ ] **Step 3: Поправить боевой догон**

В `router.post('/rules/:id/backfill', …)` заменить вычисление `planned`:

```js
    const planned = planBackfillSchedule(r.out.rows.filter(x => !x.skipReason), {
      delayDays: r.rule.delay_days, sendTime: r.rule.send_time,
      maxPerDay: r.rule.backfill_max_per_day })
      .filter(row => row.scheduledAt);
```

- [ ] **Step 4: Проверить, что ничего не отвалилось**

Run: `cd /root/loyalpro/backend && grep -rn "spreadOverDays" . --include=*.js --exclude-dir=node_modules`
Expected: пусто (ни одной ссылки).

Run: `cd /root/loyalpro/backend && node -e "require('./routes/reminders.js'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/routes/reminders.js
git commit -m "feat(reminders): превью догона разделяет просроченных и будущих

В ответе превью overdueCount/futureCount/lastOverdueAt и дата отправки в
каждой строке: слипшись в одно число, корзины читаются как «уйдёт N+M
сообщений на днях» — ровно то заблуждение, из-за которого чинили догон.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Поле правила `send_interval_min` сквозь стек

**Files:**
- Modify: `backend/migrations.js:939-957`
- Modify: `backend/routes/reminders.js` (`parseRuleBody`, `RULE_COLUMNS`, INSERT, UPDATE)
- Test: `backend/reminders-routes.test.js`

- [ ] **Step 1: Написать падающий тест валидации**

В конец `backend/reminders-routes.test.js` добавить:

```js
// Пауза между сообщениями: 0 — «без задержки», это законное значение, а не
// «поле не задано». Валидация недоверчивая, как и у остальных полей правила.
describe('sendIntervalMin', () => {
  const base = () => ({
    title: 'Эпиляция', conditions: { logic: 'and', items: [{ type: 'category', ids: [9] }] },
    delayDays: 60, text: 'Пора повторить', attributionDays: 14,
    backfillMaxPerDay: 30, sendIntervalMin: 3,
  });

  test('валидное значение проходит', () => {
    expect(parseRuleBody(base()).value.sendIntervalMin).toBe(3);
  });

  test('ноль проходит и означает «без паузы»', () => {
    expect(parseRuleBody({ ...base(), sendIntervalMin: 0 }).value.sendIntervalMin).toBe(0);
  });

  test('отрицательное отвергается', () => {
    expect(parseRuleBody({ ...base(), sendIntervalMin: -1 }).error).toMatch(/0–120/);
  });

  test('больше 120 отвергается', () => {
    expect(parseRuleBody({ ...base(), sendIntervalMin: 121 }).error).toMatch(/0–120/);
  });

  test('нечисловое отвергается, а не подставляется молча', () => {
    expect(parseRuleBody({ ...base(), sendIntervalMin: 'быстро' }).error).toMatch(/0–120/);
  });
});
```

Если в файле нет импорта `parseRuleBody`, он уже есть в шапке — проверить строкой `grep -n parseRuleBody backend/reminders-routes.test.js`.

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest reminders-routes.test.js`
Expected: FAIL — `Cannot read properties of undefined (reading 'sendIntervalMin')` на первом тесте.

- [ ] **Step 3: Миграция**

В `backend/migrations.js` в `CREATE TABLE IF NOT EXISTS reminder_rules` после строки `backfill_max_per_day INTEGER NOT NULL DEFAULT 30,` добавить:

```js
      send_interval_min    INTEGER NOT NULL DEFAULT 3,
```

И сразу после блока `CREATE INDEX IF NOT EXISTS idx_reminder_rules_salon` добавить безопасную миграцию для уже существующих баз:

```js
  // Пауза между плановыми сообщениями салона. Дефолт 3 минуты: пачка из 5
  // сообщений подряд (воркер арендует до 5 строк за тик) — риск блокировки
  // инстанса WhatsApp.
  await client.query(`
    ALTER TABLE reminder_rules
      ADD COLUMN IF NOT EXISTS send_interval_min INTEGER NOT NULL DEFAULT 3
  `).catch(() => {});
```

- [ ] **Step 4: Валидация в `parseRuleBody`**

В `backend/routes/reminders.js` после блока проверки `cap` (`if (!Number.isInteger(cap) …)`) добавить:

```js
  // 0 — законное «без паузы», поэтому нижняя граница именно 0, а не 1.
  const interval = Number(b.sendIntervalMin);
  if (!Number.isInteger(interval) || interval < 0 || interval > 120) {
    return { error: 'Пауза между сообщениями 0–120 минут' };
  }
```

В возвращаемый `value` после `backfillMaxPerDay: cap,` добавить:

```js
    sendIntervalMin: interval,
```

- [ ] **Step 5: SQL-колонки**

В `RULE_COLUMNS` после `backfill_max_per_day AS "backfillMaxPerDay",` добавить:

```js
  send_interval_min AS "sendIntervalMin",
```

В `POST /rules` заменить INSERT на (добавлен `send_interval_min`, `created_by` уехал на `$13`):

```js
      `INSERT INTO reminder_rules
         (salon_id, title, conditions, delay_days, send_time, text_mode, text,
          attribution_days, bonus_enabled, bonus_tiers, backfill_max_per_day,
          send_interval_min, created_by)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
       RETURNING ${RULE_COLUMNS}`,
      [req.user.salonId, v.title, JSON.stringify(v.conditions), v.delayDays, v.sendTime,
       v.textMode, v.text, v.attributionDays, v.bonusEnabled, JSON.stringify(v.bonusTiers),
       v.backfillMaxPerDay, v.sendIntervalMin, req.user.userId]);
```

В `PUT /rules/:id` заменить UPDATE на:

```js
      `UPDATE reminder_rules
          SET title=$3, conditions=$4::jsonb, delay_days=$5, send_time=$6, text_mode=$7,
              text=$8, attribution_days=$9, bonus_enabled=$10, bonus_tiers=$11::jsonb,
              backfill_max_per_day=$12, send_interval_min=$13, updated_at=NOW()
        WHERE id=$1 AND salon_id=$2
        RETURNING ${RULE_COLUMNS}`,
      [req.params.id, req.user.salonId, v.title, JSON.stringify(v.conditions), v.delayDays,
       v.sendTime, v.textMode, v.text, v.attributionDays, v.bonusEnabled,
       JSON.stringify(v.bonusTiers), v.backfillMaxPerDay, v.sendIntervalMin]);
```

- [ ] **Step 6: Прогнать тесты**

Run: `cd /root/loyalpro/backend && npx jest reminders-routes.test.js`
Expected: PASS.

- [ ] **Step 7: Применить миграцию на дев-БД**

Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro --update-env && sleep 4 && pm2 logs loyalpro --lines 20 --nostream`
Expected: процесс `online`, в логах нет ошибок миграций.

Run:
```bash
cd /root/loyalpro/backend && node -e "
const {db}=require('./db');
db.any(\"SELECT column_name FROM information_schema.columns WHERE table_name='reminder_rules' AND column_name='send_interval_min'\")
 .then(r=>{console.log(r.length?'ok: колонка есть':'FAIL: колонки нет');process.exit(r.length?0:1)});
"
```
Expected: `ok: колонка есть`

- [ ] **Step 8: Коммит**

```bash
cd /root/loyalpro && git add backend/migrations.js backend/routes/reminders.js backend/reminders-routes.test.js
git commit -m "feat(reminders): поле правила send_interval_min (пауза между сообщениями)

Колонка + недоверчивая валидация 0-120 (0 = без паузы) + CRUD. Само
ожидание паузы — в следующем коммите, тут только настройка.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Модуль темпа отправки

**Files:**
- Create: `backend/services/messaging/send-pacing.js`
- Test: `backend/messaging-send-pacing.test.js`

- [ ] **Step 1: Написать падающие тесты**

Создать `backend/messaging-send-pacing.test.js`:

```js
'use strict';
// Темп плановых отправок. Чистая часть — без БД.
const { waitMsLeft } = require('./services/messaging/send-pacing');

const NOW = Date.parse('2026-08-08T11:00:00+03:00');
const ago = (min) => new Date(NOW - min * 60000);

test('никогда не отправляли → ждать нечего', () => {
  expect(waitMsLeft(null, 3, NOW)).toBe(0);
});

test('интервал 0 → ждать нечего даже сразу после отправки', () => {
  expect(waitMsLeft(ago(0), 0, NOW)).toBe(0);
});

test('интервал не истёк → ждать остаток', () => {
  expect(waitMsLeft(ago(1), 3, NOW)).toBe(2 * 60000);
});

test('интервал истёк ровно → ждать нечего', () => {
  expect(waitMsLeft(ago(3), 3, NOW)).toBe(0);
});

test('интервал истёк с запасом → ждать нечего, отрицательного не возвращаем', () => {
  expect(waitMsLeft(ago(50), 3, NOW)).toBe(0);
});

// sent_at приходит из pg объектом Date, а тесты и скрипты подают ISO-строку —
// та же готча, что в attribution.sentMsOf.
test('ISO-строка понимается наравне с объектом Date', () => {
  expect(waitMsLeft(ago(1).toISOString(), 3, NOW)).toBe(2 * 60000);
});

test('мусорная дата → ждать нечего (fail-open, темп не блокирует отправку)', () => {
  expect(waitMsLeft('позавчера', 3, NOW)).toBe(0);
});

test('нечисловой интервал → ждать нечего', () => {
  expect(waitMsLeft(ago(0), 'три', NOW)).toBe(0);
});
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest messaging-send-pacing.test.js`
Expected: FAIL — `Cannot find module './services/messaging/send-pacing'`.

- [ ] **Step 3: Реализовать модуль**

Создать `backend/services/messaging/send-pacing.js`:

```js
'use strict';
// Темп плановых отправок: «не чаще одного сообщения раз в N минут». Счётчик
// ОБЩИЙ на обе плановые очереди салона — напоминания о повторном визите и
// касания «Заботы»: WhatsApp блокирует НОМЕР, а не правило, поэтому считать
// надо всё, что уходит с одного инстанса Chatpush. Тот же UNION, что в
// соседнем daily-limit.js («1 плановое сообщение клиенту в день»), только
// без фильтра по телефону: тут ограничивается темп, а не адресат.
//
// ЧЕГО ЭТА ПРОВЕРКА НЕ ДАЁТ:
//  - это чтение перед действием без блокировки, и защита ПРОЦЕССНАЯ (прод —
//    один инстанс pm2 fork), тот же класс, что _tickInFlight воркера;
//  - между проверкой и реальной отправкой проходит LLM-проход (до 60с в
//    режиме free), поэтому фактический интервал может оказаться БОЛЬШЕ
//    настроенного — ошибка в безопасную сторону;
//  - строка, откатившаяся из 'sent' обратно в 'scheduled' (сбой отправки),
//    чистит sent_at и из счётчика выпадает: темп на шаг ускорится, но
//    сообщение по ней и не ушло.
//
// Ждёт интервал ТОЛЬКО воркер напоминаний. Касания «Заботы» в счётчик
// ВХОДЯТ (напоминание не уйдёт вплотную за касанием), но сам care-воркер
// паузу не держит: у программ «Заботы» такой настройки нет, и добавлять её
// в модуль, который сейчас не трогаем, было бы лишним. Зазор известен:
// программа с большим числом касаний на одно утро отправит их пачкой.

const LAST_SENT_SQL = `
  SELECT max(t.sent_at) AS last_at FROM (
    SELECT s.sent_at
      FROM care_touch_sends s
      JOIN care_enrollments e ON e.id = s.enrollment_id
     WHERE e.salon_id = $1 AND s.status = 'sent'
    UNION ALL
    SELECT q.sent_at
      FROM reminder_queue q
     WHERE q.salon_id = $1 AND q.status = 'sent'
  ) t`;

/** Когда салон последний раз отправлял плановое сообщение. Date | null. */
async function lastPlannedSendAt(db, salonId) {
  const row = await db.oneOrNone(LAST_SENT_SQL, [salonId]);
  return row && row.last_at ? new Date(row.last_at) : null;
}

/**
 * Сколько миллисекунд ещё ждать до следующей отправки. 0 — можно слать.
 * Fail-open на мусорном входе: темп — это защита от блокировки мессенджера,
 * а не гейт допуска, и битое значение не должно останавливать очередь.
 *
 * @param {Date|string|null} lastAt   время последней плановой отправки
 * @param {number} intervalMin        пауза из правила (0 — без паузы)
 */
function waitMsLeft(lastAt, intervalMin, nowMs = Date.now()) {
  const mins = Number(intervalMin);
  if (!Number.isFinite(mins) || mins <= 0) return 0;
  if (lastAt == null) return 0;
  const last = lastAt instanceof Date ? lastAt.getTime() : Date.parse(lastAt);
  if (!Number.isFinite(last)) return 0;
  const left = last + mins * 60000 - nowMs;
  return left > 0 ? left : 0;
}

module.exports = { lastPlannedSendAt, waitMsLeft, LAST_SENT_SQL };
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd /root/loyalpro/backend && npx jest messaging-send-pacing.test.js`
Expected: PASS, 8 тестов.

- [ ] **Step 5: Проверить SQL живьём на дев-БД**

Юнит-моки валидность SQL не проверяют — тот же довод, что для LEASE_SQL в CLAUDE.md.

```bash
cd /root/loyalpro/backend && node -e "
const {db}=require('./db');
const {lastPlannedSendAt}=require('./services/messaging/send-pacing');
lastPlannedSendAt(db,1).then(v=>{console.log('ok:',v);process.exit(0)})
 .catch(e=>{console.error('FAIL',e.message);process.exit(1)});
"
```
Expected: `ok: null` или `ok: <дата>` — без ошибки SQL.

- [ ] **Step 6: Коммит**

```bash
cd /root/loyalpro && git add backend/services/messaging/send-pacing.js backend/messaging-send-pacing.test.js
git commit -m "feat(messaging): модуль темпа плановых отправок

Счётчик общий на обе очереди салона (напоминания + «Забота»): WhatsApp
блокирует номер, а не правило. Ждать интервал будет воркер напоминаний —
в следующем коммите.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Воркер выдерживает паузу

**Files:**
- Modify: `backend/services/reminders/worker.js` (импорт, `defaultDeps`, `buildLeaseSql`, `deferRowMinutes`, `processOne`, `buildTestDeps`)
- Test: `backend/reminders-worker.test.js`

- [ ] **Step 1: Написать падающие тесты**

В `backend/reminders-worker.test.js` в конец блока `describe('гейты', …)` добавить:

```js
  // Пачка сообщений подряд = блокировка инстанса WhatsApp. Проверка стоит ДО
  // проверок YClients, бонусов и текста: откладывать надо до платного
  // LLM-вызова и до НЕОБРАТИМОГО начисления, а не после.
  test('интервал не истёк → отложено на минуты, попытки не сожжены', async () => {
    const { updates, deps } = makeDeps({
      lastPlannedSendAt: jest.fn(async () => new Date(Date.now() - 60000)),
    });
    await worker.processOne({ ...ROW, send_interval_min: 3 }, deps);
    const defers = find(updates, /make_interval\(mins/);
    expect(defers).toHaveLength(1);
    expect(defers[0].sql).toMatch(/attempts = 0/);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.applyBonus).not.toHaveBeenCalled();
    expect(deps.createMessage).not.toHaveBeenCalled();
    // Не терминально: строка остаётся scheduled и видна в интерфейсе.
    expect(find(updates, /status='skipped'|status='cancelled'/)).toHaveLength(0);
  });

  test('интервал истёк → отправляем', async () => {
    const { deps } = makeDeps({
      lastPlannedSendAt: jest.fn(async () => new Date(Date.now() - 10 * 60000)),
    });
    await worker.processOne({ ...ROW, send_interval_min: 3 }, deps);
    expect(deps.sendMessage).toHaveBeenCalled();
  });

  test('интервал 0 → счётчик даже не читается', async () => {
    const { deps } = makeDeps();
    await worker.processOne({ ...ROW, send_interval_min: 0 }, deps);
    expect(deps.lastPlannedSendAt).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalled();
  });

  // Fail-CLOSED, в отличие от большинства проверок воркера: сбой счётчика
  // означал бы отправку пачкой, то есть ровно ту блокировку мессенджера, от
  // которой пауза и защищает. Минута ожидания стоит дёшево.
  test('счётчик недоступен → откладываем, а не шлём пачкой', async () => {
    const { updates, deps } = makeDeps({
      lastPlannedSendAt: jest.fn(async () => { throw new Error('db down'); }),
    });
    await worker.processOne({ ...ROW, send_interval_min: 3 }, deps);
    expect(find(updates, /make_interval\(mins/)).toHaveLength(1);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalled();
  });
```

В `makeDeps` в объект `deps` добавить строку (рядом с `sentTodayExists`):

```js
      lastPlannedSendAt: jest.fn(async () => null),
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest reminders-worker.test.js -t "интервал"`
Expected: FAIL — отложенных строк 0, `sendMessage` вызван.

- [ ] **Step 3: Импорт и зависимость**

В `backend/services/reminders/worker.js` рядом с `const dailyLimit = require('../messaging/daily-limit');` добавить:

```js
const sendPacing = require('../messaging/send-pacing');
```

В `defaultDeps` рядом с `sentTodayExists` добавить:

```js
  lastPlannedSendAt: (salonId) => sendPacing.lastPlannedSendAt(realDb, salonId),
```

- [ ] **Step 4: Колонка в аренде**

В `buildLeaseSql` в `RETURNING` заменить строку с `r.delay_days` на:

```js
              r.delay_days, r.attribution_days, r.send_interval_min,
```

- [ ] **Step 5: `deferRowMinutes`**

Сразу после функции `deferRow` добавить:

```js
/**
 * Отложить строку на N минут (в отличие от deferRow — на сутки). Для причин,
 * которые проходят сами через минуты: пауза темпа между сообщениями. Сутки
 * тут были бы абсурдны — пауза измеряется минутами, а строка протухла бы.
 * attempts обнуляются: это не сбой отправки, а плановое ожидание. defers не
 * трогаются — предела у паузы темпа нет по построению (она всегда проходит).
 */
async function deferRowMinutes(db, row, minutes, reason) {
  const mins = Math.max(1, Math.ceil(Number(minutes) || 1));
  await db.query(
    `UPDATE reminder_queue
        SET scheduled_at = NOW() + make_interval(mins => $2),
            attempts = 0, last_attempt_at = NULL, decision_reason = $3
      WHERE id = $1`,
    [row.id, mins, reason]);
}
```

- [ ] **Step 6: Гейт в `processOne`**

В `processOne` сразу ПОСЛЕ блока анти-спама (`if (await d.sentTodayExists(sid, row.phone)) { … }`) и ДО комментария «Проверки по живым записям YClients» вставить:

```js
    // Темп отправки. Воркер арендует до 5 строк за тик и шлёт их за секунды —
    // для WhatsApp это пачка и риск блокировки инстанса. Место проверки
    // выбрано намеренно: ДО проверок YClients, бонусов и текста, потому что
    // откладывать надо до платного LLM-вызова и до НЕОБРАТИМОГО начисления.
    //
    // Fail-CLOSED, в отличие от большинства проверок воркера: недоступный
    // счётчик означал бы отправку пачкой, то есть ровно ту блокировку, от
    // которой пауза защищает. Минута ожидания стоит дёшево.
    const intervalMin = Number(row.send_interval_min) || 0;
    if (intervalMin > 0) {
      let waitMs = 0;
      try {
        const lastAt = await d.lastPlannedSendAt(sid);
        waitMs = sendPacing.waitMsLeft(lastAt, intervalMin, Date.now());
      } catch (e) {
        d.log.warn(`row #${row.id}: счётчик темпа недоступен (${e.message}) — откладываю на ${intervalMin} мин`);
        waitMs = intervalMin * 60000;
      }
      if (waitMs > 0) {
        await deferRowMinutes(db, row, waitMs / 60000,
          `темп: пауза ${intervalMin} мин между плановыми сообщениями`);
        return;
      }
    }
```

- [ ] **Step 7: Тестовая отправка паузу не ждёт**

В `buildTestDeps` в возвращаемый объект добавить (после `getCatMap`):

```js
    // 5-е отличие тестовой отправки: паузу темпа тест не ждёт. Она защищает
    // живую рассылку от блокировки мессенджера, а тест — это ОДНО сообщение
    // на свой номер; отложенная тестовая строка через час была бы погашена
    // в cancelled (processTestRow), и администратор не увидел бы ничего.
    lastPlannedSendAt: async () => null,
```

И в шапочном комментарии `buildTestDeps` («Отличий ровно четыре…») исправить на «Отличий ровно пять…», добавив пятым пунктом:

```js
//   5) пауза темпа между сообщениями не применяется (тест — одно сообщение).
```

- [ ] **Step 8: Прогнать тесты**

Run: `cd /root/loyalpro/backend && npx jest reminders-worker.test.js reminders-test-send.test.js`
Expected: PASS, все тесты обоих файлов.

- [ ] **Step 9: Живой EXPLAIN изменённого LEASE_SQL**

CLAUDE.md требует живого EXPLAIN после правок LEASE_SQL — юнит-моки `db.any` валидность SQL не проверяют, а JOIN на цель UPDATE в PG запрещён.

```bash
cd /root/loyalpro/backend && node -e "
const {db}=require('./db');
const w=require('./services/reminders/worker');
Promise.all([
  db.any('EXPLAIN '+w.LEASE_SQL,[120]),
  db.any('EXPLAIN '+w.LEASE_ONE_SQL,[1]),
]).then(([a,b])=>{console.log('LEASE_SQL ok, строк плана',a.length);console.log('LEASE_ONE_SQL ok, строк плана',b.length);process.exit(0)})
 .catch(e=>{console.error('FAIL',e.message);process.exit(1)});
"
```
Expected: обе строки `ok`, без `FAIL`.

- [ ] **Step 10: Коммит**

```bash
cd /root/loyalpro && git add backend/services/reminders/worker.js backend/reminders-worker.test.js
git commit -m "feat(reminders): воркер выдерживает паузу между сообщениями

Воркер арендует до 5 строк за тик и слал их за секунды — для WhatsApp это
пачка и риск блокировки инстанса. Проверка стоит до платного LLM-вызова и
до необратимого начисления; fail-closed, потому что сбой счётчика означал
бы ровно ту пачку, от которой пауза защищает.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: UI — поле паузы и разбивка превью

**Files:**
- Modify: `frontend/index.html:1480-1483`, блок таблицы превью догона
- Modify: `frontend/js/pages/reminders.js:123-124`, `:200-201`, `:257-290`

- [ ] **Step 1: Поле в редакторе правила**

В `frontend/index.html` заменить блок с `remCap` на:

```html
          <div style="display:flex;gap:12px;flex-wrap:wrap">
            <div class="fg" style="flex:1;min-width:150px"><label class="fl">Кап догона (в день)</label>
              <input id="remCap" type="number" min="1" max="500" value="30"></div>
            <div class="fg" style="flex:1;min-width:150px"><label class="fl">Пауза между сообщениями (мин)</label>
              <input id="remInterval" type="number" min="0" max="120" value="3"></div>
          </div>
          <div style="font-size:11px;color:var(--t3);margin:-6px 0 10px">
            Темп считается по всем плановым отправкам салона, включая «Заботу»,
            поэтому при нескольких правилах паузу задаёт то правило, чьё сообщение
            уходит сейчас. 0 — без паузы.
          </div>
```

- [ ] **Step 2: Чтение и запись поля**

В `frontend/js/pages/reminders.js` после строки с `remCap` в функции заполнения формы добавить:

```js
  document.getElementById('remInterval').value = r ? r.sendIntervalMin : 3;
```

В объекте, который уходит на сохранение, после `backfillMaxPerDay:` добавить:

```js
    sendIntervalMin: Number(document.getElementById('remInterval').value),
```

- [ ] **Step 3: Разбивка превью догона**

В `remRunBackfillPreview` заменить блок построения `box.innerHTML` на:

```js
    box.innerHTML = `
      <div style="margin:10px 0;font-size:13px">
        Записей за период: ${d.totals.records} · состоявшихся: ${d.totals.completed} ·
        под условия: ${d.totals.matched} · <b>уйдёт напоминаний: ${willSend}</b>
      </div>
      <div style="margin:0 0 10px;font-size:13px">
        Просрочено (визит был больше задержки назад): <b>${d.overdueCount}</b>${
          d.lastOverdueAt ? ` · уйдут по ${remFmt(d.lastOverdueAt)}` : ''} ·
        встанут в очередь на будущее: <b>${d.futureCount}</b>${
          d.lastScheduledAt ? ` · последнее ${remFmt(d.lastScheduledAt)}` : ''}
      </div>
      ${d.catMapFailed ? '<div class="empty" style="color:#f59e0b">Карта категорий не загрузилась — условия по категории не сработают</div>' : ''}
      <div class="tw mtbl-wrap"><table class="mtbl"><thead><tr>
        <th>Клиент</th><th>Визит</th><th>Услуги</th><th>Отправка</th><th>Итог</th>
      </tr></thead><tbody>
      ${d.rows.slice(0, 200).map(r => `<tr>
        <td class="mtbl-title"><b>${esc(r.clientName || r.phone || '')}</b></td>
        <td data-label="Визит">${remFmt(r.visitAt)}</td>
        <td class="mtbl-full" data-label="Услуги">${esc((r.services || []).map(s => s.title).join(', '))}</td>
        <td data-label="Отправка">${r.scheduledAt ? remFmt(r.scheduledAt) : '—'}</td>
        <td data-label="Итог">${r.skipReason ? `<span class="care-badge care-st-stopped">${esc(REM_SKIP_LBL[r.skipReason] || r.skipReason)}</span>`
                           : '<span class="care-badge care-st-completed">уйдёт</span>'}</td>
      </tr>`).join('')}
      </tbody></table></div>
      ${d.rows.length > 200 ? `<div style="font-size:11px;color:var(--t3);padding:6px 2px">Показаны первые 200 из ${d.rows.length}</div>` : ''}`;
```

- [ ] **Step 4: Проверить в браузере**

Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro --update-env && sleep 4 && pm2 list | grep loyalpro`
Expected: статус `online`.

Открыть админку MCP Playwright (`mcp__playwright__*`), зайти на страницу «Забота» → вкладка напоминаний, открыть редактирование правила «Лазерная эпиляция»:
- поле «Пауза между сообщениями (мин)» присутствует и показывает `3`;
- нажать «👁 Догон», период 60, «Показать выборку»;
- в шапке видно «Просрочено: 0 · встанут в очередь на будущее: N», в колонке «Отправка» у клиентов с визитом 07.08 стоит дата в октябре, а не завтра.

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add frontend/index.html frontend/js/pages/reminders.js
git commit -m "feat(reminders): UI — пауза между сообщениями и разбивка догона

В превью догона видно, сколько строк просрочено и сколько встанет на свою
естественную дату, плюс дата отправки у каждой строки: без неё
администратор не видит, что именно исправилось.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Полный прогон и живая проверка

**Files:** нет (только запуск)

- [ ] **Step 1: Все тесты модуля**

Run: `cd /root/loyalpro/backend && npx jest reminders messaging-send-pacing care`
Expected: PASS, 0 упавших сьютов.

- [ ] **Step 2: Полный прогон**

Run: `cd /root/loyalpro/backend && npx jest --testPathIgnorePatterns "primary-clients.test.js"`
Expected: PASS. `primary-clients.test.js` исключён намеренно — он зовёт `process.exit(1)` и убивает соседний сьют (известный флейк, см. память проекта).

- [ ] **Step 3: Живой прогон воркера**

`scripts/reminders-e2e.js` создаёт правило и просроченную строку, прогоняет один тик настоящего воркера и чистит за собой. Отправка и начисление застаблены по умолчанию.

Run: `cd /root/loyalpro/backend && pm2 stop loyalpro && node scripts/reminders-e2e.js; pm2 start loyalpro`
Expected: скрипт зелёный. Остановка pm2 обязательна — боевой воркер тикает раз в минуту и может арендовать строку скрипта первым.

- [ ] **Step 4: Живая тестовая отправка (HTTP-обвязка, без реальной отправки)**

Run: `cd /root/loyalpro/backend && node scripts/reminders-test-send-e2e.js`
Expected: зелёный. Проверяет, что тестовая строка проходит `processOne` с новым набором колонок аренды.

- [ ] **Step 5: Коммит, если что-то поправилось по ходу**

```bash
cd /root/loyalpro && git status --short
# если пусто — коммитить нечего, задача закрыта
```

---

## После плана (не входит в реализацию)

В боевых текстах правила «Лазерная эпиляция» (сам текст и обе ступени бонусов) стоит `[Имя]` — это не плейсхолдер, `renderReminderText` знает только `{first_name}`. Правится как данные через админку, кодовых изменений не требует.
