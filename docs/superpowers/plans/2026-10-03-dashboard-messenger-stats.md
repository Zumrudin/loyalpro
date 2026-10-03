# Статистика переписок в мессенджерах на дашборде — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** На странице «Обзор» появляется блок «Переписки в мессенджерах»: диалогов за период, сколько клиентов написали первыми, сколько из них записались в тот же день — суммарно, по дням и по каждому каналу (WhatsApp / Telegram / MAX).

**Architecture:** Один SQL с CTE считает диалог-дни из `chatpush_messages` (автоуведомления и группы исключены), связывает их по телефону с `clients` и с записями `records`, созданными в тот же московский день (`raw_payload->>'create_date'`). Чистая функция `summarize` превращает строки в ответ новой ручки `GET /api/analytics/messengers`; фронт грузит её параллельно с основным дашбордом в своём `try/catch` и рендерит три плитки, график Chart.js и таблицу по каналам.

**Tech Stack:** Node/Express, `pg` через `db.any`, Jest 30 (бэкенд), `node --test` + `vm` (фронт), Chart.js 4.4 (уже подключён), puppeteer + системный Chrome для скриншотов.

**Спека:** `docs/superpowers/specs/2026-10-03-dashboard-messenger-stats-design.md`. Макет: `docs/superpowers/specs/2026-10-03-dashboard-messenger-stats-mockup.html`.

**Готчи проекта, которые касаются этого плана:**
- Дев-сервер перезапускать ТОЛЬКО так: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro` (`--update-env` ломает порт).
- Правка JS фронта без бампа `?v=` в `frontend/index.html` до браузера не доезжает.
- Все страничные скрипты фронта делят одну глобальную область: верхнеуровневый `const`/`let`/`function` с уже занятым именем — синтаксическая ошибка, гасящая весь файл.
- Запросы к БД руками — через MCP `mcp__postgres__query` (дев-база `loyalpro_test`), не `psql`.
- Jest запускается из `backend/`: `npx jest <имя файла без .test.js>`.

---

## Карта файлов

| Файл | Ответственность |
|---|---|
| Create `backend/services/messenger-stats.js` | `MESSENGER_STATS_SQL`, `loadMessengerStats`, чистые `summarize`, `channelLabel`, `eachDate` |
| Create `backend/messenger-stats.test.js` | Jest: чистые функции + передача параметров в `db.any` |
| Modify `backend/routes/api.js` (после `/analytics/bonuses`, ~строка 495) | маршрут `GET /analytics/messengers` |
| Create `frontend/js/pages/dashboard-messengers.js` | чистые помощники (`msgPct`, `msgChannelRows`, `msgChartSeries`, `msgTileTexts`) + `renderMessengerStats`, `loadMessengerStats`, `clearMessengerStats` |
| Create `frontend/js/pages/dashboard-messengers.test.js` | `node --test`: помощники + загрузка вместе с `dashboard.js` в одном `vm`-контексте |
| Modify `frontend/index.html` (блок между `.sg` строки 211–217 и `.g32` строки 218; `<script>` строка 2488) | разметка блока, подключение скрипта с `?v=` |
| Modify `frontend/css/features.css` (в конец) | стили `.msg-*` |
| Modify `frontend/js/pages/dashboard.js` (`showDashSkeleton` :242, `loadDashboard` :254) | скелетон новых плиток, вызов `loadMessengerStats(q)` |
| Create `backend/scripts/dashboard-messengers-visual.js` | живой скриншот блока в двух темах с дев-сервера |
| Modify `CLAUDE.md` | короткий раздел про блок и его определения |

---

### Task 1: Чистая сводка `summarize` (бэкенд)

**Files:**
- Create: `backend/services/messenger-stats.js`
- Test: `backend/messenger-stats.test.js`

- [ ] **Step 1: Написать падающий тест на чистые функции**

```js
// backend/messenger-stats.test.js
'use strict';
const { summarize, channelLabel, eachDate } = require('./services/messenger-stats');

describe('messenger-stats: channelLabel', () => {
  test('известные каналы получают человеческие имена, прочие — как есть', () => {
    expect(channelLabel('tdlib')).toBe('Telegram');
    expect(channelLabel('whatsapp')).toBe('WhatsApp');
    expect(channelLabel('max')).toBe('MAX');
    expect(channelLabel('max_bot')).toBe('max_bot');
    expect(channelLabel(null)).toBe('—');
  });
});

describe('messenger-stats: eachDate', () => {
  test('перечисляет каждый день включительно', () => {
    expect(eachDate('2026-09-29', '2026-10-02')).toEqual(
      ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });
  test('один день → один элемент', () => {
    expect(eachDate('2026-10-03', '2026-10-03')).toEqual(['2026-10-03']);
  });
});

describe('messenger-stats: summarize', () => {
  const rows = [
    { date: '2026-10-01', channel: 'tdlib',    dialogs: 5, client_first: 3, client_first_no_phone: 1, booked_same_day: 2, booked_by_agent: 1 },
    { date: '2026-10-01', channel: 'whatsapp', dialogs: 2, client_first: 2, client_first_no_phone: 0, booked_same_day: 1, booked_by_agent: 0 },
    { date: '2026-10-03', channel: 'tdlib',    dialogs: '4', client_first: '1', client_first_no_phone: '0', booked_same_day: '0', booked_by_agent: '0' },
  ];
  const out = summarize(rows, { from: '2026-10-01', to: '2026-10-03' });

  test('итоги — суммы по всем строкам, строки pg приводятся к числам', () => {
    expect(out.totals).toEqual({ dialogs: 11, clientFirst: 6, clientFirstNoPhone: 1, bookedSameDay: 3, bookedByAgent: 1 });
    expect(out.period).toEqual({ from: '2026-10-01', to: '2026-10-03' });
  });

  test('разрез по каналам: метка, сортировка по dialogs убыванию', () => {
    expect(out.byChannel.map(c => c.channel)).toEqual(['tdlib', 'whatsapp']);
    expect(out.byChannel[0]).toEqual({ channel: 'tdlib', label: 'Telegram', dialogs: 9, clientFirst: 4, clientFirstNoPhone: 1, bookedSameDay: 2, bookedByAgent: 1 });
  });

  test('ряд по дням покрывает каждый день периода, пустые дни — нулями', () => {
    expect(out.daily).toEqual([
      { date: '2026-10-01', clientFirst: 5, bookedSameDay: 3 },
      { date: '2026-10-02', clientFirst: 0, bookedSameDay: 0 },
      { date: '2026-10-03', clientFirst: 1, bookedSameDay: 0 },
    ]);
  });

  test('инварианты dialogs ≥ clientFirst ≥ bookedSameDay держатся на итогах и каналах', () => {
    for (const s of [out.totals, ...out.byChannel]) {
      expect(s.dialogs).toBeGreaterThanOrEqual(s.clientFirst);
      expect(s.clientFirst).toBeGreaterThanOrEqual(s.bookedSameDay);
      expect(s.bookedSameDay).toBeGreaterThanOrEqual(s.bookedByAgent);
    }
  });

  test('пустой вход → нули, пустые каналы, ряд из нулей', () => {
    const e = summarize([], { from: '2026-10-02', to: '2026-10-03' });
    expect(e.totals).toEqual({ dialogs: 0, clientFirst: 0, clientFirstNoPhone: 0, bookedSameDay: 0, bookedByAgent: 0 });
    expect(e.byChannel).toEqual([]);
    expect(e.daily).toEqual([
      { date: '2026-10-02', clientFirst: 0, bookedSameDay: 0 },
      { date: '2026-10-03', clientFirst: 0, bookedSameDay: 0 },
    ]);
  });

  test('дата из pg может прийти объектом Date — нормализуется к YYYY-MM-DD', () => {
    const r = summarize([{ date: new Date('2026-10-02T00:00:00Z'), channel: 'max', dialogs: 1, client_first: 1, client_first_no_phone: 0, booked_same_day: 0, booked_by_agent: 0 }],
      { from: '2026-10-02', to: '2026-10-02' });
    expect(r.daily).toEqual([{ date: '2026-10-02', clientFirst: 1, bookedSameDay: 0 }]);
  });
});
```

- [ ] **Step 2: Запустить тест — должен упасть**

Run: `cd /root/loyalpro/backend && npx jest messenger-stats 2>&1 | tail -15`
Expected: FAIL, `Cannot find module './services/messenger-stats'`.

- [ ] **Step 3: Написать минимальную реализацию чистых функций**

```js
// backend/services/messenger-stats.js
'use strict';
// ============================================================
// Статистика переписок в мессенджерах для дашборда.
// Спека: docs/superpowers/specs/2026-10-03-dashboard-messenger-stats-design.md
//
// Единица счёта — ДИАЛОГ-ДЕНЬ (собеседник + московская дата), автоуведомления
// (authored_by='system') и групповые чаты не считаются. «Клиент написал
// первым» — первое неслужебное сообщение дня входящее. «Записался в тот же
// день» — у клиента с этим телефоном есть запись YClients, СОЗДАННАЯ в этот
// день (raw_payload->>'create_date', московское локальное время), статус не
// 'deleted'. records.created_at для этого не годится: это время вставки нашей
// строки (у source='sync' — время синка).
// ============================================================

const CHANNEL_LABELS = { tdlib: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX' };

function channelLabel(channel) {
  if (channel == null || channel === '') return '—';
  return CHANNEL_LABELS[channel] || String(channel);
}

// Перечисление дат включительно; арифметика в UTC, чтобы DST не съел день.
function eachDate(from, to) {
  const out = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function dateKey(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

const n = v => Number(v) || 0;

function emptyStat() {
  return { dialogs: 0, clientFirst: 0, clientFirstNoPhone: 0, bookedSameDay: 0, bookedByAgent: 0 };
}

function addRow(acc, r) {
  acc.dialogs += n(r.dialogs);
  acc.clientFirst += n(r.client_first);
  acc.clientFirstNoPhone += n(r.client_first_no_phone);
  acc.bookedSameDay += n(r.booked_same_day);
  acc.bookedByAgent += n(r.booked_by_agent);
}

// rows: [{date, channel, dialogs, client_first, client_first_no_phone, booked_same_day, booked_by_agent}]
function summarize(rows, { from, to }) {
  const totals = emptyStat();
  const byChannelMap = new Map();
  const byDay = new Map(eachDate(from, to).map(d => [d, { date: d, clientFirst: 0, bookedSameDay: 0 }]));

  for (const r of rows || []) {
    addRow(totals, r);
    const ch = r.channel == null ? '' : String(r.channel);
    if (!byChannelMap.has(ch)) byChannelMap.set(ch, { channel: ch, label: channelLabel(ch), ...emptyStat() });
    addRow(byChannelMap.get(ch), r);
    const day = byDay.get(dateKey(r.date));
    if (day) { day.clientFirst += n(r.client_first); day.bookedSameDay += n(r.booked_same_day); }
  }

  const byChannel = [...byChannelMap.values()]
    .sort((a, b) => (b.dialogs - a.dialogs) || a.channel.localeCompare(b.channel));

  return { period: { from, to }, totals, byChannel, daily: [...byDay.values()] };
}

module.exports = { summarize, channelLabel, eachDate, CHANNEL_LABELS };
```

- [ ] **Step 4: Запустить тест — должен пройти**

Run: `cd /root/loyalpro/backend && npx jest messenger-stats 2>&1 | tail -15`
Expected: `Tests: 9 passed`.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/messenger-stats.js backend/messenger-stats.test.js && git commit -m "feat(dashboard): чистая сводка статистики переписок (summarize, channelLabel, eachDate)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: SQL и `loadMessengerStats`

**Files:**
- Modify: `backend/services/messenger-stats.js`
- Test: `backend/messenger-stats.test.js`

- [ ] **Step 1: Дописать падающий тест на загрузчик**

Добавить в конец `backend/messenger-stats.test.js`:

```js
describe('messenger-stats: loadMessengerStats', () => {
  const { loadMessengerStats, MESSENGER_STATS_SQL } = require('./services/messenger-stats');

  test('передаёт salon_id, from, to параметрами $1..$3 и отдаёт строки db.any', async () => {
    const calls = [];
    const db = { any: async (sql, params) => { calls.push({ sql, params }); return [{ date: '2026-10-01', channel: 'tdlib', dialogs: 1, client_first: 1, client_first_no_phone: 0, booked_same_day: 0, booked_by_agent: 0 }]; } };
    const rows = await loadMessengerStats(7, '2026-10-01', '2026-10-03', { db });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe(MESSENGER_STATS_SQL);
    expect(calls[0].params).toEqual([7, '2026-10-01', '2026-10-03']);
    expect(rows).toHaveLength(1);
  });

  test('SQL исключает автоуведомления и группы и использует ключ диалога «Чата»', () => {
    expect(MESSENGER_STATS_SQL).toMatch(/authored_by,\s*''\)\s*<>\s*'system'/);
    expect(MESSENGER_STATS_SQL).toMatch(/NOT LIKE '-%'/);
    expect(MESSENGER_STATS_SQL).toMatch(/NOT LIKE '%@g\.us'/);
    expect(MESSENGER_STATS_SQL).toMatch(/create_date/);
    // Ключ диалога — ТОТ ЖЕ, что в services/chat.js (одно правило на систему).
    const { DIALOG_KEY_SQL } = require('./services/chat');
    expect(MESSENGER_STATS_SQL).toContain(DIALOG_KEY_SQL);
  });
});
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `cd /root/loyalpro/backend && npx jest messenger-stats 2>&1 | tail -15`
Expected: FAIL, `loadMessengerStats is not a function`.

- [ ] **Step 3: Добавить SQL и загрузчик**

`DIALOG_KEY_SQL` уже экспортируется из `backend/services/chat.js` (строка 103). В `backend/services/messenger-stats.js` перед `module.exports`:

```js
const { DIALOG_KEY_SQL } = require('./chat');

// $1 salon_id, $2 from 'YYYY-MM-DD', $3 to 'YYYY-MM-DD' (включительно, мск).
// Экспортируется ради живого EXPLAIN ANALYZE на дев-БД (как LEASE_SQL воркеров).
const MESSENGER_STATS_SQL = `
WITH m AS (
  SELECT
    ${DIALOG_KEY_SQL} AS dkey,
    (to_timestamp(msg_ts) AT TIME ZONE 'Europe/Moscow')::date AS d,
    channel, direction, msg_ts, id,
    NULLIF(right(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 10), '') AS p10
  FROM chatpush_messages
  WHERE salon_id = $1
    AND msg_ts IS NOT NULL
    AND (to_timestamp(msg_ts) AT TIME ZONE 'Europe/Moscow')::date BETWEEN $2::date AND $3::date
    AND COALESCE(chat_id,'') NOT LIKE '-%'
    AND COALESCE(chat_id,'') NOT LIKE '%@g.us'
    AND COALESCE(chat_id,'') NOT LIKE '%@broadcast'
    AND COALESCE(authored_by,'') <> 'system'
),
firsts AS (
  SELECT DISTINCT ON (dkey, d) dkey, d, direction AS first_dir, channel AS first_channel
  FROM m ORDER BY dkey, d, msg_ts, id
),
phones AS (
  SELECT dkey, d, max(p10) AS p10 FROM m GROUP BY dkey, d
),
dd AS (
  SELECT f.dkey, f.d, f.first_dir, f.first_channel, p.p10
  FROM firsts f JOIN phones p USING (dkey, d)
),
cl AS (
  SELECT dd.dkey, dd.d, c.id AS client_id, c.yclients_client_id
  FROM dd JOIN clients c
    ON c.salon_id = $1 AND dd.p10 IS NOT NULL
   AND c.phone = ANY (ARRAY['+7' || dd.p10, '7' || dd.p10, '8' || dd.p10, dd.p10])
),
rec AS (
  SELECT r.client_id, r.yclients_client_id,
         left(r.raw_payload->>'create_date', 10) AS cd,
         EXISTS (SELECT 1 FROM agent_events e
                  WHERE e.salon_id = r.salon_id AND e.kind = 'booking_created'
                    AND e.payload->>'record_id' = r.yclients_record_id::text) AS by_agent
  FROM records r
  WHERE r.salon_id = $1 AND r.status <> 'deleted'
    AND left(r.raw_payload->>'create_date', 10) BETWEEN $2 AND $3
),
flags AS (
  SELECT dd.*,
    EXISTS (SELECT 1 FROM cl JOIN rec
              ON rec.client_id = cl.client_id
              OR (rec.yclients_client_id IS NOT NULL AND rec.yclients_client_id = cl.yclients_client_id)
            WHERE cl.dkey = dd.dkey AND cl.d = dd.d AND rec.cd = dd.d::text) AS booked,
    EXISTS (SELECT 1 FROM cl JOIN rec
              ON rec.client_id = cl.client_id
              OR (rec.yclients_client_id IS NOT NULL AND rec.yclients_client_id = cl.yclients_client_id)
            WHERE cl.dkey = dd.dkey AND cl.d = dd.d AND rec.cd = dd.d::text AND rec.by_agent) AS booked_by_agent
  FROM dd
)
SELECT d::text AS date, first_channel AS channel,
  COUNT(*)::int AS dialogs,
  COUNT(*) FILTER (WHERE first_dir = 'incoming')::int AS client_first,
  COUNT(*) FILTER (WHERE first_dir = 'incoming' AND p10 IS NULL)::int AS client_first_no_phone,
  COUNT(*) FILTER (WHERE first_dir = 'incoming' AND booked)::int AS booked_same_day,
  COUNT(*) FILTER (WHERE first_dir = 'incoming' AND booked_by_agent)::int AS booked_by_agent
FROM flags
GROUP BY d, first_channel
ORDER BY d, first_channel`;

async function loadMessengerStats(salonId, from, to, deps = {}) {
  const db = deps.db || require('../db').db;
  return db.any(MESSENGER_STATS_SQL, [salonId, from, to]);
}
```

и расширить экспорт:

```js
module.exports = { summarize, channelLabel, eachDate, CHANNEL_LABELS, MESSENGER_STATS_SQL, loadMessengerStats };
```

ВНИМАНИЕ: в шаблонной строке JS регулярка пишется `'\\D'`, чтобы в SQL ушло `'\D'`.

- [ ] **Step 4: Запустить тест — должен пройти**

Run: `cd /root/loyalpro/backend && npx jest messenger-stats 2>&1 | tail -15`
Expected: `Tests: 11 passed`.

- [ ] **Step 5: Живой EXPLAIN ANALYZE и сверка с ручным замером на дев-БД**

Распечатать SQL с подставленными параметрами и выполнить через MCP `mcp__postgres__query`:

Run (одинарные кавычки обязательны — внутри `$1`, который bash в двойных кавычках подставил бы):

```bash
cd /root/loyalpro/backend && node -e 'const {MESSENGER_STATS_SQL}=require("./services/messenger-stats");console.log("EXPLAIN (ANALYZE, BUFFERS) "+MESSENGER_STATS_SQL.replace(/\$1/g,"1").replace(/\$2/g,"'"'"'2026-09-04'"'"'").replace(/\$3/g,"'"'"'2026-10-03'"'"'"))'
```

Вставить вывод в `mcp__postgres__query`. Expected: `Execution Time` < 300 ms, без ошибок синтаксиса.

Затем тот же SQL без `EXPLAIN` — сверить итоги по каналам с замером из спеки (30 дней до 03.10.2026, `salon_id=1`): `client_first` ≈ tdlib 201 / whatsapp 102 / max 83, `booked_same_day` ≈ 81 / 39 / 34 (допуск ±5 % — спечный замер не исключал автоуведомления из первого сообщения дня, здесь исключает). Если расхождение больше — разобраться ДО следующей задачи, не подгонять.

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add backend/services/messenger-stats.js backend/messenger-stats.test.js && git commit -m "feat(dashboard): SQL диалог-дней по мессенджерам и записей в тот же день

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Маршрут `GET /api/analytics/messengers`

**Files:**
- Modify: `backend/routes/api.js` (вставить после закрывающей `});` маршрута `/analytics/bonuses`, перед `router.get('/analytics/retention'`)

- [ ] **Step 1: Добавить импорт и маршрут**

В шапку `backend/routes/api.js` после строки `const { computeStaffMetrics } = require('../services/staff');`:

```js
const { loadMessengerStats, summarize: summarizeMessengerStats } = require('../services/messenger-stats');
```

После маршрута `/analytics/bonuses`:

```js
// Блок «Переписки в мессенджерах» на дашборде. Грузится фронтом отдельным
// запросом (как /analytics/bonuses): сбой здесь не должен ронять дашборд.
router.get('/analytics/messengers', auth, async (req, res) => {
  try {
    const sid = req.user.salonId;
    const { from, to } = resolvePeriod(req);
    const rows = await loadMessengerStats(sid, from, to);
    res.json(summarizeMessengerStats(rows, { from, to }));
  } catch (e) {
    logger.warn(`analytics/messengers: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Перезапустить дев-сервер и проверить ручку живьём**

Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 3 && pm2 logs loyalpro --lines 5 --nostream`
Expected: процесс `online`, в логе нет ошибок загрузки модулей.

Получить токен и дёрнуть ручку (тот же приём, что в `scripts/chat-escalation-visual.js`):

```bash
cd /root/loyalpro/backend && node -e "
require('dotenv').config();
const jwt=require('jsonwebtoken');const config=require('./config');const {db}=require('./db');
(async()=>{
  const u=await db.oneOrNone(\"SELECT id,salon_id,role FROM users WHERE role IN ('owner','admin') ORDER BY id LIMIT 1\");
  const t=jwt.sign({userId:u.id,salonId:u.salon_id,role:u.role},config.JWT_SECRET,{expiresIn:'10m'});
  await db.query(\"INSERT INTO sessions (user_id,token,ip,user_agent,expires_at) VALUES (\$1,\$2,'127.0.0.1','msg-stats-check',NOW()+INTERVAL '10 minutes')\",[u.id,t]);
  const r=await fetch('http://127.0.0.1:3001/api/analytics/messengers?from=2026-09-04&to=2026-10-03',{headers:{Authorization:'Bearer '+t}});
  console.log(r.status); const j=await r.json(); console.log(JSON.stringify(j.totals), j.byChannel.map(c=>c.label+':'+c.dialogs+'/'+c.clientFirst+'/'+c.bookedSameDay).join(' '), 'daily', j.daily.length);
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});"
```

Expected: `200`, итоги ненулевые, три канала, `daily 30`.

Второй вызов без параметров (`?period=today` неявно через фолбэк): `curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <тот же токен>" http://127.0.0.1:3001/api/analytics/messengers` → `200`. Без токена → `401`.

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro && git add backend/routes/api.js && git commit -m "feat(dashboard): ручка GET /api/analytics/messengers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Чистые помощники фронта

**Files:**
- Create: `frontend/js/pages/dashboard-messengers.js`
- Test: `frontend/js/pages/dashboard-messengers.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// frontend/js/pages/dashboard-messengers.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { msgPct, msgChannelRows, msgChartSeries, msgTileTexts, MSG_CHANNEL_BADGE } = require('./dashboard-messengers');

test('msgPct: округлённый процент, при нулевом знаменателе — прочерк', () => {
  assert.strictEqual(msgPct(81, 201), '40%');
  assert.strictEqual(msgPct(0, 10), '0%');
  assert.strictEqual(msgPct(5, 0), '—');
  assert.strictEqual(msgPct(undefined, undefined), '—');
});

test('msgChannelRows: строка на канал + итоговая, бейдж и конверсия', () => {
  const byChannel = [
    { channel: 'tdlib', label: 'Telegram', dialogs: 382, clientFirst: 201, clientFirstNoPhone: 27, bookedSameDay: 81, bookedByAgent: 30 },
    { channel: 'max_bot', label: 'max_bot', dialogs: 3, clientFirst: 1, clientFirstNoPhone: 0, bookedSameDay: 0, bookedByAgent: 0 },
  ];
  const totals = { dialogs: 385, clientFirst: 202, clientFirstNoPhone: 27, bookedSameDay: 81, bookedByAgent: 30 };
  const rows = msgChannelRows(byChannel, totals);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0], { label: 'Telegram', short: 'TG', cls: 'ch-tg', dialogs: 382, clientFirst: 201, bookedSameDay: 81, conv: '40%', convPct: 40, isTotal: false });
  // незнакомый канал — бейдж из первых двух букв, нейтральный класс
  assert.strictEqual(rows[1].short, 'MA');
  assert.strictEqual(rows[1].cls, 'ch-all');
  assert.strictEqual(rows[1].conv, '0%');
  assert.deepStrictEqual(rows[2], { label: 'Все каналы', short: 'Σ', cls: 'ch-all', dialogs: 385, clientFirst: 202, bookedSameDay: 81, conv: '40%', convPct: 40, isTotal: true });
});

test('msgChannelRows: без каналов — только итог с нулями', () => {
  const rows = msgChannelRows([], { dialogs: 0, clientFirst: 0, clientFirstNoPhone: 0, bookedSameDay: 0, bookedByAgent: 0 });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].isTotal, true);
  assert.strictEqual(rows[0].conv, '—');
  assert.strictEqual(rows[0].convPct, 0);
});

test('msgChartSeries: подписи d.m и два ряда чисел', () => {
  const s = msgChartSeries([
    { date: '2026-09-04', clientFirst: 12, bookedSameDay: 5 },
    { date: '2026-10-01', clientFirst: '3', bookedSameDay: '1' },
  ]);
  assert.deepStrictEqual(s, { labels: ['4.9', '1.10'], first: [12, 3], booked: [5, 1] });
  assert.deepStrictEqual(msgChartSeries([]), { labels: [], first: [], booked: [] });
});

test('msgTileTexts: подписи трёх плиток', () => {
  const t = msgTileTexts({ dialogs: 716, clientFirst: 386, clientFirstNoPhone: 30, bookedSameDay: 154, bookedByAgent: 61 });
  assert.strictEqual(t.firstShare, '54% диалогов');
  assert.strictEqual(t.firstSub, '30 из них без номера телефона');
  assert.strictEqual(t.bookedPct, '40%');
  assert.strictEqual(t.bookedSub, 'из написавших первыми · 61 оформила Мила');
});

test('msgTileTexts: нули и отсутствие Милы/без номера', () => {
  const t = msgTileTexts({ dialogs: 0, clientFirst: 0, clientFirstNoPhone: 0, bookedSameDay: 0, bookedByAgent: 0 });
  assert.strictEqual(t.firstShare, '');
  assert.strictEqual(t.firstSub, 'все с номером телефона');
  assert.strictEqual(t.bookedPct, '');
  assert.strictEqual(t.bookedSub, 'из написавших первыми');
});

test('бейджи известных каналов', () => {
  assert.deepStrictEqual(MSG_CHANNEL_BADGE.whatsapp, { short: 'WA', cls: 'ch-wa' });
  assert.deepStrictEqual(MSG_CHANNEL_BADGE.max, { short: 'M', cls: 'ch-max' });
});

// Файл делит глобальную область со всеми страничными скриптами: верхнеуровневое
// имя, занятое в dashboard.js, — синтаксическая ошибка, гасящая ВЕСЬ файл
// (класс дефекта chat-wait-status.js). Грузим оба файла в один vm-контекст, как браузер.
test('dashboard.js и dashboard-messengers.js живут в одной глобальной области', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const ctx = vm.createContext({ console });
  ctx.window = ctx;
  for (const f of ['dashboard.js', 'dashboard-messengers.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.doesNotThrow(() => vm.runInContext(src, ctx, { filename: f }),
      `${f} не загрузился в общей области — проверь редекларацию имён`);
  }
  assert.strictEqual(typeof ctx.loadMessengerStats, 'function');
  assert.strictEqual(typeof ctx.renderMessengerStats, 'function');
  assert.strictEqual(typeof ctx.loadDashboard, 'function');
  assert.strictEqual(ctx.msgPct(1, 4), '25%');
});
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `cd /root/loyalpro/frontend/js/pages && node --test dashboard-messengers.test.js 2>&1 | tail -8`
Expected: FAIL, `Cannot find module './dashboard-messengers'`.

- [ ] **Step 3: Написать помощники (пока без DOM-части)**

```js
// frontend/js/pages/dashboard-messengers.js
// ── ДАШБОРД: блок «Переписки в мессенджерах» ─────────────────────────────
// Спека: docs/superpowers/specs/2026-10-03-dashboard-messenger-stats-design.md
// Данные — GET /api/analytics/messengers?from&to (та же пара дат, что у
// остального дашборда). Проценты считает фронт, бэкенд отдаёт только счётчики.
// Файл подключён обычным <script> и делит глобальную область с dashboard.js:
// никаких верхнеуровневых имён, уже занятых там (rCh, bfCh, lvlCh, dashRange…).
// Зависимости из core: api(), esc(), animateCount(); Chart из vendor.

const MSG_CHANNEL_BADGE = {
  tdlib:    { short: 'TG', cls: 'ch-tg' },
  whatsapp: { short: 'WA', cls: 'ch-wa' },
  max:      { short: 'M',  cls: 'ch-max' },
};

function msgPct(part, whole) {
  const p = Number(part) || 0, w = Number(whole) || 0;
  return w > 0 ? Math.round(p / w * 100) + '%' : '—';
}

function msgConvPct(part, whole) {
  const p = Number(part) || 0, w = Number(whole) || 0;
  return w > 0 ? Math.round(p / w * 100) : 0;
}

function msgBadge(channel) {
  const known = MSG_CHANNEL_BADGE[channel];
  if (known) return known;
  return { short: String(channel || '?').slice(0, 2).toUpperCase(), cls: 'ch-all' };
}

function msgRow(label, badge, s, isTotal) {
  return {
    label, short: badge.short, cls: badge.cls,
    dialogs: Number(s.dialogs) || 0,
    clientFirst: Number(s.clientFirst) || 0,
    bookedSameDay: Number(s.bookedSameDay) || 0,
    conv: msgPct(s.bookedSameDay, s.clientFirst),
    convPct: msgConvPct(s.bookedSameDay, s.clientFirst),
    isTotal,
  };
}

function msgChannelRows(byChannel, totals) {
  const rows = (byChannel || []).map(c => msgRow(c.label || c.channel, msgBadge(c.channel), c, false));
  rows.push(msgRow('Все каналы', { short: 'Σ', cls: 'ch-all' }, totals || {}, true));
  return rows;
}

function msgChartSeries(daily) {
  const labels = [], first = [], booked = [];
  for (const d of daily || []) {
    const [, m, day] = String(d.date).slice(0, 10).split('-');
    labels.push(parseInt(day, 10) + '.' + parseInt(m, 10));
    first.push(Number(d.clientFirst) || 0);
    booked.push(Number(d.bookedSameDay) || 0);
  }
  return { labels, first, booked };
}

function msgTileTexts(t) {
  const s = t || {};
  const noPhone = Number(s.clientFirstNoPhone) || 0;
  const byAgent = Number(s.bookedByAgent) || 0;
  return {
    firstShare: s.dialogs > 0 ? msgPct(s.clientFirst, s.dialogs) + ' диалогов' : '',
    firstSub: noPhone > 0 ? noPhone + ' из них без номера телефона' : 'все с номером телефона',
    bookedPct: s.clientFirst > 0 ? msgPct(s.bookedSameDay, s.clientFirst) : '',
    bookedSub: 'из написавших первыми' + (byAgent > 0 ? ' · ' + byAgent + ' оформила Мила' : ''),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { msgPct, msgChannelRows, msgChartSeries, msgTileTexts, MSG_CHANNEL_BADGE };
}
```

- [ ] **Step 4: Запустить — помощники проходят, vm-тест ещё падает**

Run: `cd /root/loyalpro/frontend/js/pages && node --test dashboard-messengers.test.js 2>&1 | tail -12`
Expected: 7 pass, 1 fail (`typeof ctx.loadMessengerStats` — функции DOM-части ещё нет). Это ожидаемо: DOM-часть пишется в Task 5.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add frontend/js/pages/dashboard-messengers.js frontend/js/pages/dashboard-messengers.test.js && git commit -m "feat(dashboard): чистые помощники блока переписок (проценты, строки таблицы, ряды графика)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Разметка, стили, рендер и подключение к дашборду

**Files:**
- Modify: `frontend/index.html` (между `</div>` строки 217 и `<div class="g32 mb">` строки 218; `<script>` строка 2488)
- Modify: `frontend/css/features.css` (в конец)
- Modify: `frontend/js/pages/dashboard-messengers.js` (DOM-часть)
- Modify: `frontend/js/pages/dashboard.js:242-252` (`showDashSkeleton`), `:314-331` (`loadDashboard`)

- [ ] **Step 1: Разметка блока в `frontend/index.html`**

Вставить сразу после закрывающего `</div>` ряда `.sg mb` с «ROI программы» (строка 217) и перед `<div class="g32 mb">` с `revChart`:

```html
      <!-- ── Переписки в мессенджерах (спека docs/superpowers/specs/2026-10-03-dashboard-messenger-stats-design.md) ── -->
      <div class="msg-head">
        <div class="ttl">Переписки в мессенджерах</div>
        <div class="sub" id="msgPeriodSub"></div>
      </div>
      <div class="msg-tiles mb">
        <div class="sc"><div class="sl">Диалогов за период</div><div class="sv" id="msgDialogs">—</div><div class="sd" id="msgDialogsSub">дней общения с клиентами · без автоуведомлений</div></div>
        <div class="sc"><div class="sl">Клиент написал первым</div><div class="sv"><span id="msgFirst">—</span><span class="msg-pct msg-pct-muted" id="msgFirstShare"></span></div><div class="sd" id="msgFirstSub"><span class="dot" style="background:#3b82f6"></span></div></div>
        <div class="sc"><div class="sl">Записались в тот же день</div><div class="sv"><span id="msgBooked">—</span><span class="msg-pct" id="msgBookedPct"></span></div><div class="sd" id="msgBookedSub"><span class="dot" style="background:var(--a)"></span></div></div>
      </div>
      <div class="g32 mb">
        <div class="card">
          <div class="ct"><span>Написали первыми и записались по дням</span>
            <div class="msg-legend"><span style="--lg:#3b82f6">Написали первыми</span><span style="--lg:var(--a)">Записались в тот же день</span></div></div>
          <div style="height:220px"><canvas id="msgChart"></canvas></div>
        </div>
        <div class="card">
          <div class="ct">По мессенджерам</div>
          <table class="msg-tbl">
            <thead><tr><th>Канал</th><th>Диалогов</th><th>Первым</th><th>Записались</th><th>Конверсия</th></tr></thead>
            <tbody id="msgTbody"><tr><td colspan="5" class="empty">Нет данных</td></tr></tbody>
          </table>
          <div class="msg-foot">Диалог считается за день. «Первым» — первое сообщение дня от клиента, автоуведомления YClients не в счёт. «Записались» — запись в YClients создана в тот же день (кем угодно).</div>
        </div>
      </div>
```

- [ ] **Step 2: Подключить скрипт с бампом версии**

В `frontend/index.html` строку

```html
<script src="js/pages/dashboard.js?v=2026-08-19-metricsfix2"></script>
```

заменить на

```html
<script src="js/pages/dashboard.js?v=2026-10-03-messengers"></script>
<script src="js/pages/dashboard-messengers.js?v=2026-10-03a"></script>
```

И бампнуть версию стилей (строка 26), иначе новые `.msg-*` правила из Step 3 не доедут до браузера:

```html
<link rel="stylesheet" href="css/features.css?v=2026-10-03-messengers">
```

- [ ] **Step 3: Стили в конец `frontend/css/features.css`**

```css
/* ── Дашборд: блок «Переписки в мессенджерах» ─────────────────────────────── */
.msg-head{display:flex;align-items:baseline;justify-content:space-between;margin:26px 0 12px}
.msg-head .ttl{font-size:16px;font-weight:700}
.msg-head .sub{font-size:11.5px;color:var(--t3)}
.msg-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.msg-tiles .sv{display:flex;align-items:baseline;gap:8px}
.msg-pct{font-size:13px;font-weight:700;color:var(--a)}
.msg-pct-muted{color:var(--t3);font-weight:500}
.msg-tiles .sd .dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;vertical-align:1px}
.msg-legend{display:flex;gap:14px;font-size:11px;color:var(--t2);font-weight:400}
.msg-legend span::before{content:"";display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px;background:var(--lg)}
.msg-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.msg-tbl th{font-size:10.5px;font-weight:500;color:var(--t3);text-align:right;padding:0 0 10px 12px;border-bottom:1px solid var(--bd);white-space:nowrap}
.msg-tbl th:first-child{text-align:left;padding-left:0}
.msg-tbl td{padding:11px 0 11px 12px;border-bottom:1px solid var(--bd);text-align:right;vertical-align:middle}
.msg-tbl td:first-child{text-align:left;padding-left:0}
.msg-tbl tr:last-child td{border-bottom:none}
.msg-tbl tr.total td{font-weight:700;border-top:2px solid var(--bd)}
.msg-tbl td.empty{text-align:center}
.msg-tbl .ch{display:inline-flex;align-items:center;gap:7px;font-weight:600}
.msg-tbl .ch i{width:22px;height:22px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;font-style:normal;flex:none}
.msg-tbl .ch-wa i{background:#25d366}.msg-tbl .ch-tg i{background:#2aabee}.msg-tbl .ch-max i{background:#7b5cff}.msg-tbl .ch-all i{background:var(--t3)}
.msg-tbl .conv{display:inline-flex;align-items:center;gap:8px;justify-content:flex-end}
.msg-tbl .conv .pb{width:70px;height:6px;background:var(--bg);border:1px solid var(--bd);border-radius:4px;overflow:hidden;display:inline-block}
.msg-tbl .conv .pf{height:100%;background:var(--a);border-radius:4px;display:block}
.msg-tbl .conv b{min-width:34px;text-align:right}
.msg-foot{font-size:11px;color:var(--t3);margin-top:12px;line-height:1.5}
@media(max-width:900px){.msg-tiles{grid-template-columns:1fr}}
```

- [ ] **Step 4: DOM-часть в `frontend/js/pages/dashboard-messengers.js`**

Вставить ПЕРЕД блоком `if (typeof module !== 'undefined' …)`:

```js
// ── DOM-часть (в node --test не вызывается) ──────────────────────────────
let msgCh; // экземпляр Chart, как rCh/bfCh/lvlCh в dashboard.js

function msgSetText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function msgSetSub(id, dotColor, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = (dotColor ? '<span class="dot" style="background:' + dotColor + '"></span>' : '') + esc(text);
}

function renderMessengerTable(rows) {
  const tbody = document.getElementById('msgTbody');
  if (!tbody) return;
  const dataRows = rows.filter(r => !r.isTotal);
  if (!dataRows.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">Нет данных</td></tr>'; return; }
  tbody.innerHTML = rows.map(r => `
    <tr${r.isTotal ? ' class="total"' : ''}>
      <td><span class="ch ${esc(r.cls)}"><i>${esc(r.short)}</i>${esc(r.label)}</span></td>
      <td>${r.dialogs}</td>
      <td>${r.clientFirst}</td>
      <td>${r.bookedSameDay}</td>
      <td><span class="conv"><span class="pb"><span class="pf" style="width:${r.convPct}%"></span></span><b>${esc(r.conv)}</b></span></td>
    </tr>`).join('');
}

function renderMessengerChart(daily) {
  const canvas = document.getElementById('msgChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const s = msgChartSeries(daily);
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  // Палитра проверена валидатором dataviz в обеих темах: в тёмной зелёный темнее.
  const GREEN = dark ? '#00a87c' : '#00c896', BLUE = '#3b82f6';
  const ink = dark ? '#8b949e' : '#57606a';
  if (msgCh) msgCh.destroy();
  msgCh = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels: s.labels, datasets: [
      { label: 'Написали первыми', data: s.first, backgroundColor: BLUE, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom', barPercentage: 0.85, categoryPercentage: 0.8 },
      { label: 'Записались в тот же день', data: s.booked, backgroundColor: GREEN, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom', barPercentage: 0.85, categoryPercentage: 0.8 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { footer: items => {
        const f = items[0]?.raw || 0, b = items[1]?.raw || 0;
        return f ? 'Конверсия ' + Math.round(b / f * 100) + '%' : '';
      } } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 15, font: { size: 10 }, color: ink } },
        y: { beginAtZero: true, grid: { color: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }, ticks: { precision: 0, font: { size: 10 }, color: ink } },
      },
    },
  });
}

function renderMessengerStats(data, periodLabel) {
  const t = (data && data.totals) || {};
  const texts = msgTileTexts(t);
  animateCount(document.getElementById('msgDialogs'), Number(t.dialogs) || 0);
  animateCount(document.getElementById('msgFirst'), Number(t.clientFirst) || 0);
  animateCount(document.getElementById('msgBooked'), Number(t.bookedSameDay) || 0);
  msgSetText('msgFirstShare', texts.firstShare);
  msgSetText('msgBookedPct', texts.bookedPct);
  msgSetText('msgDialogsSub', 'дней общения с клиентами · без автоуведомлений');
  msgSetSub('msgFirstSub', '#3b82f6', texts.firstSub);
  msgSetSub('msgBookedSub', 'var(--a)', texts.bookedSub);
  const chans = ((data && data.byChannel) || []).map(c => c.label).join(', ');
  msgSetText('msgPeriodSub', (periodLabel ? 'за ' + periodLabel : '') + (chans ? ' · ' + chans : ''));
  renderMessengerTable(msgChannelRows((data && data.byChannel) || [], t));
  renderMessengerChart((data && data.daily) || []);
}

// Пустое/аварийное состояние: блок не прячем, показываем прочерки.
function clearMessengerStats() {
  ['msgDialogs', 'msgFirst', 'msgBooked'].forEach(id => msgSetText(id, '—'));
  ['msgFirstShare', 'msgBookedPct', 'msgPeriodSub'].forEach(id => msgSetText(id, ''));
  msgSetText('msgDialogsSub', 'нет данных за период');
  msgSetSub('msgFirstSub', '', '');
  msgSetSub('msgBookedSub', '', '');
  renderMessengerTable([]);
  if (msgCh) { msgCh.destroy(); msgCh = null; }
}

// q — '?from=YYYY-MM-DD&to=YYYY-MM-DD', та же строка, что у /api/analytics/dashboard.
async function loadMessengerStats(q, periodLabel) {
  try {
    const data = await api('GET', '/api/analytics/messengers' + q);
    renderMessengerStats(data, periodLabel);
  } catch (e) {
    console.warn('Messenger stats failed:', e);
    clearMessengerStats();
  }
}
```

- [ ] **Step 5: Подключить к `dashboard.js`**

В `showDashSkeleton` (строка 243) дополнить список id:

```js
  const ids = ['ds1', 'ds2', 'ds3', 'ds5', 'ds6', 'an1', 'an2', 'an3', 'an4', 'an5', 'msgDialogs', 'msgFirst', 'msgBooked'];
```

В `loadDashboard` сразу после блока `try { buildBfChart(...) } catch …` (строки 318–323) и перед `buildLvlChart(d.levelDist);` добавить:

```js
    // Блок «Переписки в мессенджерах» — отдельная ручка, свой try/catch внутри:
    // сбой статистики переписок не должен гасить остальной дашборд.
    if (typeof loadMessengerStats === 'function') {
      await loadMessengerStats(q, formatPeriodLabel(dashRange.from, dashRange.to));
    }
```

- [ ] **Step 6: Запустить тесты фронта — все проходят**

Run: `cd /root/loyalpro/frontend/js/pages && node --test dashboard-messengers.test.js 2>&1 | tail -8`
Expected: `# pass 8`, `# fail 0`.

Также прогнать соседний тест на общую область, чтобы ничего не задеть: `node --test chat-wait-status.test.js 2>&1 | tail -3` → `# fail 0`.

- [ ] **Step 7: Проверить в браузере живьём**

Статика отдаётся бэкендом без перезапуска. Открыть дашборд headless-Chrome и снять скриншот (полная проверка — в Task 6, здесь быстрый дым-тест):

```bash
cd /root/loyalpro/backend && node -e "
require('dotenv').config();
const jwt=require('jsonwebtoken');const puppeteer=require('puppeteer');const config=require('./config');const {db}=require('./db');
(async()=>{
  const u=await db.oneOrNone(\"SELECT id,salon_id,role FROM users WHERE role IN ('owner','admin') ORDER BY id LIMIT 1\");
  const t=jwt.sign({userId:u.id,salonId:u.salon_id,role:u.role},config.JWT_SECRET,{expiresIn:'10m'});
  await db.query(\"INSERT INTO sessions (user_id,token,ip,user_agent,expires_at) VALUES (\$1,\$2,'127.0.0.1','msg-smoke',NOW()+INTERVAL '10 minutes')\",[u.id,t]);
  const b=await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-dev-shm-usage'],executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome'});
  const p=await b.newPage(); await p.setViewport({width:1280,height:900});
  p.on('pageerror',e=>console.log('PAGE ERROR',e.message));
  await p.evaluateOnNewDocument(tk=>localStorage.setItem('lp_tk',tk),t);
  await p.goto('http://127.0.0.1:3001/#dashboard',{waitUntil:'networkidle2'});
  await p.waitForFunction(()=>/\\d/.test(document.getElementById('msgDialogs')?.textContent||''),{timeout:20000});
  console.log('tiles:',await p.evaluate(()=>['msgDialogs','msgFirst','msgBooked'].map(i=>document.getElementById(i).textContent).join(' / ')));
  console.log('rows:',await p.evaluate(()=>document.querySelectorAll('#msgTbody tr').length));
  await p.screenshot({path:'/tmp/dashboard-messengers-smoke.png',fullPage:true});
  await b.close(); process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});"
```

Expected: без `PAGE ERROR`, плитки с числами, `rows: 4` (три канала + итог). Открыть `/tmp/dashboard-messengers-smoke.png` (Read) и сверить с макетом: блок между рядом карточек и «Выручкой по дням», заголовки таблицы не слипаются, легенда в заголовке графика.

- [ ] **Step 8: Commit**

```bash
cd /root/loyalpro && git add frontend/index.html frontend/css/features.css frontend/js/pages/dashboard-messengers.js frontend/js/pages/dashboard.js && git commit -m "feat(dashboard): блок «Переписки в мессенджерах» — плитки, график по дням, таблица по каналам

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Живая визуальная проверка в двух темах

**Files:**
- Create: `backend/scripts/dashboard-messengers-visual.js`

- [ ] **Step 1: Написать скрипт**

```js
'use strict';
// ============================================================
// Визуальная проверка блока «Переписки в мессенджерах» на дашборде.
// Гоняется против ЗАПУЩЕННОГО дев-сервера, поднимает headless-Chrome,
// кладёт свежий токен в localStorage и открывает «Обзор».
//
//   node scripts/dashboard-messengers-visual.js
//
// Проверяет: блок отрисован на периоде «Месяц» (плитки с числами, в таблице
// каналы + итог, у графика есть canvas), переключение на «Сегодня» перерисовывает
// без ошибок страницы, тёмная тема не ломает вёрстку. Скриншоты —
// /tmp/dashboard-messengers-{light,dark,today}.png. Ничего не пишет в БД,
// кроме временной строки sessions под токен.
// ============================================================
require('dotenv').config();
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const config = require('../config');
const { db } = require('../db');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3001';
const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const fail = (m) => { throw new Error(m); };

async function main() {
  const user = await db.oneOrNone(
    `SELECT id, salon_id, role FROM users WHERE role IN ('owner','admin') ORDER BY id LIMIT 1`);
  if (!user) fail('нет ни одного owner/admin в базе');
  const token = jwt.sign({ userId: user.id, salonId: user.salon_id, role: user.role },
    config.JWT_SECRET, { expiresIn: '10m' });
  await db.query(
    `INSERT INTO sessions (user_id, token, ip, user_agent, expires_at)
     VALUES ($1, $2, '127.0.0.1', 'dashboard-messengers-visual', NOW() + INTERVAL '10 minutes')`,
    [user.id, token]);

  const browser = await puppeteer.launch({
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument((t) => localStorage.setItem('lp_tk', t), token);
    await page.goto(BASE + '/#dashboard', { waitUntil: 'networkidle2' });

    const tilesFilled = () => page.waitForFunction(
      () => ['msgDialogs', 'msgFirst', 'msgBooked'].every(id => /^\d/.test((document.getElementById(id) || {}).textContent || '')),
      { timeout: 20000, polling: 200 });

    // ── Месяц (светлая тема) ──
    await page.click('#page-dashboard .pb-btn[data-preset="month"]');
    await tilesFilled();
    const month = await page.evaluate(() => ({
      tiles: ['msgDialogs', 'msgFirst', 'msgBooked'].map(id => document.getElementById(id).textContent),
      rows: document.querySelectorAll('#msgTbody tr').length,
      hasCanvas: !!document.getElementById('msgChart'),
      sub: document.getElementById('msgPeriodSub').textContent,
    }));
    if (month.rows < 2) fail(`в таблице ${month.rows} строк — ожидались каналы + итог`);
    if (!month.hasCanvas) fail('нет canvas графика');
    if (!/за .+·/.test(month.sub)) fail(`подпись периода пуста: «${month.sub}»`);
    ok(`месяц: плитки ${month.tiles.join(' / ')}, строк в таблице ${month.rows}, подпись «${month.sub}»`);
    const block = await page.$('.msg-head');
    await block.evaluate(el => el.scrollIntoView());
    await page.screenshot({ path: '/tmp/dashboard-messengers-light.png', fullPage: true });

    // ── Сегодня: перерисовка без ошибок, допустимы нули ──
    await page.click('#page-dashboard .pb-btn[data-preset="today"]');
    await page.waitForFunction(() => /^(\d|—)/.test(document.getElementById('msgDialogs').textContent), { timeout: 20000, polling: 200 });
    await new Promise(r => setTimeout(r, 800));
    const today = await page.evaluate(() => document.getElementById('msgDialogs').textContent);
    ok(`сегодня: диалогов «${today}»`);
    await page.screenshot({ path: '/tmp/dashboard-messengers-today.png', fullPage: true });

    // ── Тёмная тема ──
    // Ключ темы — тот же, что в frontend/js/core/theme.js (lp_dark = '1').
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); localStorage.setItem('lp_dark', '1'); });
    await page.click('#page-dashboard .pb-btn[data-preset="month"]');
    await tilesFilled();
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({ path: '/tmp/dashboard-messengers-dark.png', fullPage: true });
    ok('тёмная тема отрисована');

    if (pageErrors.length) fail('ошибки страницы: ' + pageErrors.join(' | '));
    ok('ошибок страницы нет');
    console.log('\nСкриншоты: /tmp/dashboard-messengers-{light,today,dark}.png');
  } finally {
    await browser.close();
    await db.query(`DELETE FROM sessions WHERE token = $1`, [token]).catch(() => {});
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('\x1b[31m✗\x1b[0m ' + e.message); process.exit(1); });
```

- [ ] **Step 2: Запустить скрипт**

Run: `cd /root/loyalpro/backend && node scripts/dashboard-messengers-visual.js`
Expected: четыре зелёные галочки, выход 0.

- [ ] **Step 3: Посмотреть скриншоты**

Read `/tmp/dashboard-messengers-light.png` и `/tmp/dashboard-messengers-dark.png`. Проверить глазами: заголовки колонок не слипаются, легенда не наезжает на заголовок карточки, столбики двух цветов различимы в тёмной теме, подпись под таблицей читается. Любой дефект чинить в `features.css` и переснимать; после каждой правки CSS менять `?v=` у `css/features.css` в `frontend/index.html` (строка 26), иначе браузер покажет старые стили.

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro && git add backend/scripts/dashboard-messengers-visual.js frontend/css/features.css frontend/index.html && git commit -m "test(dashboard): живая визуальная проверка блока переписок в двух темах

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Полный прогон тестов и документация

**Files:**
- Modify: `CLAUDE.md` (новый подраздел в `## Architecture`, после «### Frontend (staff SPA)»)

- [ ] **Step 1: Прогнать затронутые сьюты бэкенда и фронта**

Run: `cd /root/loyalpro/backend && npx jest messenger-stats chat 2>&1 | tail -6`
Expected: все `passed`.

Run: `cd /root/loyalpro/frontend/js/pages && node --test dashboard-messengers.test.js chat-wait-status.test.js chat-dialog-sort.test.js 2>&1 | tail -4`
Expected: `# fail 0`.

- [ ] **Step 2: Дописать CLAUDE.md**

Вставить после раздела «### Frontend (staff SPA)» (перед «### Роутинг по hash»):

```markdown
### Дашборд: блок «Переписки в мессенджерах»
Спека `docs/superpowers/specs/2026-10-03-dashboard-messenger-stats-design.md`, макет рядом (`…-mockup.html`). Ручка `GET /api/analytics/messengers?from&to` (`routes/api.js`, тот же `resolvePeriod`, что у дашборда), SQL и чистая сводка — `services/messenger-stats.js` (`MESSENGER_STATS_SQL` экспортируется ради живого EXPLAIN; тесты `messenger-stats.test.js`), фронт — `frontend/js/pages/dashboard-messengers.js` (чистые помощники + рендер, `node --test` в `vm` вместе с `dashboard.js` — общая глобальная область), живая проверка `scripts/dashboard-messengers-visual.js`.
- Единица — ДИАЛОГ-ДЕНЬ (ключ диалога `DIALOG_KEY_SQL` из `services/chat.js` + московская дата). Автоуведомления (`authored_by='system'`) и группы не считаются: без этого 606 из 771 «клиника первой» за месяц были отбивками YClients, и клиент, ответивший вопросом на напоминание, не считался бы «написавшим первым».
- «Записался в тот же день» — запись `records` с `left(raw_payload->>'create_date',10)` = день диалога и `status<>'deleted'`, связь по телефону (`clients.phone = ANY(['+7'||p10, …])`, индекс) и по `client_id`/`yclients_client_id`. `records.created_at` НЕ годится — это время вставки нашей строки. Источник записи данными не доказуем (администратор мог внести руками) — подпись под таблицей говорит это явно; отдельно считается «оформила Мила» по `agent_events.booking_created`.
- Диалоги без номера (скрытый номер в Telegram/MAX) в «записались» попасть не могут и показываются отдельной цифрой, чтобы не читаться как «не записались».
- Фронт грузит ручку в своём try/catch после основного дашборда: сбой → прочерки, остальные карточки живут. Правка JS — с бампом `?v=`.
```

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro && git add CLAUDE.md && git commit -m "docs: раздел CLAUDE.md про блок «Переписки в мессенджерах» на дашборде

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 4: Итоговая сверка со спекой**

Пройти по спеке и отметить: определения (диалог-день, первым, записался, период, единица) — Task 2 SQL; доп. цифры (без номера, Мила) — Task 2 + Task 4/5; архитектура (отдельная ручка) — Task 3; фронт (плитки, график, таблица, скелетон, бамп, мобильная вёрстка) — Task 5; крайние случаи — SQL Task 2 (пустой p10, DISTINCT ON с тай-брейком `id`, EXISTS от дублей карточек); тесты — Tasks 1, 2, 4, 6. Прод-выкат в план НЕ входит — отдельное решение владельца.
