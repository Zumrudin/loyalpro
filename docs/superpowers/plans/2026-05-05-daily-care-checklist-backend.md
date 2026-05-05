# Daily Care Checklist — Backend & Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `/root/mobile/docs/superpowers/specs/2026-05-05-daily-care-checklist-design.md`

**Companion plan:** `/root/mobile/docs/superpowers/plans/2026-05-05-daily-care-checklist-mobile.md` (ВЫПОЛНЯТЬ ПОСЛЕ ЭТОГО ПЛАНА — мобильная часть зависит от готовых API)

**Goal:** Расширить существующую фичу «Назначения» в LoyalPro расписанием (дни недели + период курса), логом выполнения пациентом и admin-UI с adherence-показателем и heatmap-календарём.

**Architecture:** Миграция расширяет `home_care_prescriptions` (start_date, end_date) и `home_care_items` (days_of_week SMALLINT[]), добавляет таблицу `home_care_completions` для лога. Существующий `routes/home-care.js` расширяется приёмом новых полей и колонкой adherence в списке + новым эндпоинтом heatmap. В `routes/mobile-client.js` появляются 4 новых эндпоинта (today-checklist GET, complete POST/DELETE, prescription adherence GET) и расширяется GET prescription detail. Админский UI в `frontend/js/pages/home-care.js` (vanilla JS) получает блок «Период курса», ряды дней недели на item-строках, колонку «% выполнения» в списке и модалку heatmap.

**Tech Stack:** Node.js 18 / Express / pg-promise (`db`) / vanilla JS frontend / pm2 в качестве процесс-менеджера. Никаких тестовых фреймворков — проверки делаем через `curl`, `psql`/`db.any` инлайн и логи pm2.

---

## File Map

**Бэкенд:**
- Modify: `/root/loyalpro/backend/migrations.js` — миграция новых колонок и таблицы `home_care_completions`
- Modify: `/root/loyalpro/backend/routes/home-care.js` — приём `start_date` / `end_date` / `days_of_week`, выдача `adherence_pct` в списке, новый эндпоинт `/:id/adherence-history`
- Modify: `/root/loyalpro/backend/routes/mobile-client.js` — 4 новых мобильных эндпоинта + расширение существующего prescription-detail

**Админка (frontend):**
- Modify: `/root/loyalpro/frontend/js/pages/home-care.js` — блок «Период курса», ряды дней недели в форме, колонка % в списке, модалка heatmap

---

## Pre-Flight: проверки окружения

- [ ] **Step 1: Убедиться, что бэкенд отвечает**

```bash
pm2 status loyalpro
curl -fsS http://localhost:3000/api/app-settings | head -c 200
```

Ожидаемо: pm2 показывает `online`, curl возвращает JSON с `success: true`.

- [ ] **Step 2: Запомнить рабочую директорию**

```bash
cd /root/loyalpro && pwd && git status -s
```

Ожидаемо: `/root/loyalpro`, рабочее дерево чистое (или содержит только незакомиченные изменения, не относящиеся к этой задаче).

---

## Task 1: Миграции БД

**Files:**
- Modify: `/root/loyalpro/backend/migrations.js`

- [ ] **Step 1: Найти точку вставки**

В файле `/root/loyalpro/backend/migrations.js` найти существующий блок `// ── Prescriptions: link to records ──`:

```js
  // ── Prescriptions: link to records ─────────────────────────
  await client.query(`
    ALTER TABLE home_care_prescriptions
      ADD COLUMN IF NOT EXISTS record_id INTEGER REFERENCES records(id) ON DELETE SET NULL
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_hcp_record_id ON home_care_prescriptions(record_id)
  `).catch(() => {});
```

Сразу после этих двух запросов (т.е. после второго `.catch(() => {});`) вставить новый блок миграций.

- [ ] **Step 2: Вставить блок миграций**

Вставить ровно следующий код:

```js
  // ── Daily Care Checklist: schedule fields ──────────────────
  await client.query(`
    ALTER TABLE home_care_prescriptions
      ADD COLUMN IF NOT EXISTS start_date DATE,
      ADD COLUMN IF NOT EXISTS end_date   DATE
  `).catch(() => {});

  // backfill старых prescription без start_date
  await client.query(`
    UPDATE home_care_prescriptions
       SET start_date = DATE(created_at)
     WHERE start_date IS NULL
  `).catch(() => {});

  // start_date NOT NULL после backfill
  await client.query(`
    ALTER TABLE home_care_prescriptions
      ALTER COLUMN start_date SET NOT NULL
  `).catch(() => {});

  await client.query(`
    ALTER TABLE home_care_items
      ADD COLUMN IF NOT EXISTS days_of_week SMALLINT[]
  `).catch(() => {});

  // ── Daily Care Checklist: completions log ──────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS home_care_completions (
      id              SERIAL PRIMARY KEY,
      item_id         INTEGER NOT NULL REFERENCES home_care_items(id) ON DELETE CASCADE,
      client_id       INTEGER NOT NULL REFERENCES clients(id)         ON DELETE CASCADE,
      completion_date DATE      NOT NULL,
      completed_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (item_id, client_id, completion_date)
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_hcc_client_date
      ON home_care_completions (client_id, completion_date DESC)
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_hcc_item_date
      ON home_care_completions (item_id, completion_date)
  `).catch(() => {});
```

- [ ] **Step 3: Перезапустить бэкенд**

```bash
pm2 restart loyalpro && sleep 3 && pm2 logs loyalpro --lines 30 --nostream
```

Ожидаемо: сервер стартует без ошибок. Сообщения вида `column "..." of relation "..." already exists` безопасны (`.catch(() => {})`).

- [ ] **Step 4: Проверить, что миграции применились**

```bash
node -e "
const {db} = require('/root/loyalpro/backend/db');
(async () => {
  const cols = await db.any(\`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name = 'home_care_prescriptions'
       AND column_name IN ('start_date', 'end_date')
  \`);
  console.log('home_care_prescriptions:', cols);
  const itemCols = await db.any(\`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_name = 'home_care_items' AND column_name = 'days_of_week'
  \`);
  console.log('home_care_items:', itemCols);
  const tbl = await db.any(\`
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'home_care_completions' ORDER BY ordinal_position
  \`);
  console.log('home_care_completions:', tbl);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
```

Ожидаемо в выводе:
- `start_date` (date, NO), `end_date` (date, YES)
- `days_of_week` (ARRAY)
- 5 колонок в `home_care_completions`: id, item_id, client_id, completion_date, completed_at

- [ ] **Step 5: Проверить backfill**

```bash
node -e "
const {db} = require('/root/loyalpro/backend/db');
(async () => {
  const r = await db.one('SELECT COUNT(*) AS total, COUNT(start_date) AS with_start FROM home_care_prescriptions');
  console.log(r);
  process.exit(r.total === r.with_start ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
"
```

Ожидаемо: `total === with_start` (все строки получили start_date).

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add backend/migrations.js
git commit -m "feat(db): add schedule fields and completions log for daily care checklist

- home_care_prescriptions: start_date (NOT NULL after backfill), end_date
- home_care_items: days_of_week SMALLINT[]
- new home_care_completions (item_id, client_id, completion_date, completed_at)
- two indexes on completions for fast adherence/heatmap lookups

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: home-care.js — приём start_date / end_date / days_of_week (POST + PUT)

**Files:**
- Modify: `/root/loyalpro/backend/routes/home-care.js`

- [ ] **Step 1: Найти POST-обработчик**

Открыть `/root/loyalpro/backend/routes/home-care.js`. Найти тело `router.post('/'`. Должно начинаться с деструктуризации:

```js
    const { client_id, face_procedures, body_procedures, hair_procedures, vitamins, notes, items = [], record_id } = req.body;
```

(Это строка после Task 2 предыдущего плана — в ней уже есть `record_id`.)

- [ ] **Step 2: Добавить парсинг новых полей в POST**

Заменить строку деструктуризации на:

```js
    const {
      client_id, face_procedures, body_procedures, hair_procedures,
      vitamins, notes, items = [], record_id,
      start_date, end_date,
    } = req.body;

    // Нормализация start_date: для homecare обязательно, иначе текущая дата
    const startDateValue = start_date || new Date().toISOString().slice(0, 10);
    const endDateValue   = end_date || null;
```

- [ ] **Step 3: Обновить INSERT prescription**

В POST найти SQL `INSERT INTO home_care_prescriptions (...)` (он сейчас принимает 9 значений, заканчиваясь на `record_id`). Заменить на версию с двумя дополнительными колонками:

```js
    const p = await db.one(
      `INSERT INTO home_care_prescriptions
         (salon_id, client_id, specialist_id, face_procedures, body_procedures,
          hair_procedures, vitamins, notes, record_id, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        req.user.salonId, client_id || null, req.user.userId,
        face_procedures || null, body_procedures || null,
        hair_procedures || null, vitamins || null, notes || null,
        record_id || null, startDateValue, endDateValue,
      ]
    );
```

- [ ] **Step 4: Обновить INSERT items в POST — нормализовать days_of_week**

В POST найти цикл вставки items (выглядит как `for (const it of items) { ... INSERT INTO home_care_items ... }`). Перед циклом добавить хелпер нормализации:

```js
    function normalizeDays(raw) {
      if (!Array.isArray(raw)) return null;
      const cleaned = [...new Set(raw
        .map(n => parseInt(n, 10))
        .filter(n => Number.isInteger(n) && n >= 0 && n <= 6))]
        .sort((a, b) => a - b);
      // Все 7 или 0 = ежедневно (NULL в БД)
      if (cleaned.length === 0 || cleaned.length === 7) return null;
      return cleaned;
    }
```

В самом INSERT items добавить новый параметр `days_of_week`:

```js
      await db.query(
        `INSERT INTO home_care_items
           (prescription_id, time_of_day, category, product_name, instructions, sort_order, days_of_week)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          p.id, it.time_of_day, it.category, it.product_name,
          it.instructions || null, i, normalizeDays(it.days_of_week),
        ]
      );
```

(`i` здесь — переменная цикла, она уже есть в существующем коде.)

- [ ] **Step 5: Аналогично обновить PUT**

Найти `router.put('/:id'`. Применить те же изменения:

1. Добавить `start_date, end_date` в деструктуризацию:

```js
    const {
      client_id, face_procedures, body_procedures, hair_procedures,
      vitamins, notes, items = [], record_id,
      start_date, end_date,
    } = req.body;
    const startDateValue = start_date || new Date().toISOString().slice(0, 10);
    const endDateValue   = end_date || null;
```

2. Обновить `UPDATE home_care_prescriptions SET …`:

```js
    await db.query(
      `UPDATE home_care_prescriptions
          SET client_id=$1, face_procedures=$2, body_procedures=$3,
              hair_procedures=$4, vitamins=$5, notes=$6, record_id=$7,
              start_date=$8, end_date=$9, updated_at=NOW()
        WHERE id=$10`,
      [
        client_id || null, face_procedures || null, body_procedures || null,
        hair_procedures || null, vitamins || null, notes || null,
        record_id || null, startDateValue, endDateValue, req.params.id,
      ]
    );
```

3. В цикле items в PUT тоже использовать `normalizeDays(it.days_of_week)` и расширенный INSERT (та же функция и тот же SQL, что в Step 4 — `normalizeDays` объявить ещё раз внутри обработчика PUT, чтобы не выносить в общий скоуп; дублирование оправдано: два изолированных хэндлера).

- [ ] **Step 6: Перезапустить и проверить отсутствие синтаксических ошибок**

```bash
pm2 restart loyalpro && sleep 2 && pm2 logs loyalpro --lines 30 --nostream
```

Ожидаемо: сервер запускается, в логах нет «SyntaxError» / «Cannot find module».

- [ ] **Step 7: Smoke-тест POST через curl (опционально, если есть JWT админа)**

Если у тебя под рукой нет admin-токена — пропусти этот шаг, сделаешь интеграционный тест после Task 5 одной серией. Если токен есть:

```bash
TOKEN="<paste admin token>"
curl -fsS -X POST http://localhost:3000/api/home-care \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "client_id": 1,
    "items": [
      {"time_of_day":"morning","category":"Уход","product_name":"Тест-крем","instructions":"тонким слоем","days_of_week":[0,2,4]}
    ],
    "start_date": "2026-05-05",
    "end_date":   "2026-06-05"
  }' | head -c 200
```

Ожидаемо: `{"success":true,"id":<число>}`. В БД у этого prescription `start_date='2026-05-05'`, `end_date='2026-06-05'`, у item `days_of_week='{0,2,4}'`.

- [ ] **Step 8: Commit**

```bash
cd /root/loyalpro && git add backend/routes/home-care.js
git commit -m "feat(home-care): accept start_date/end_date and per-item days_of_week

POST and PUT now persist course period on prescription and weekly schedule
on each item. Empty/full days_of_week is normalized to NULL (= daily).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: home-care.js — adherence_pct в GET-списке

**Files:**
- Modify: `/root/loyalpro/backend/routes/home-care.js`

- [ ] **Step 1: Найти текущий GET-список**

Найти `router.get('/'` в `home-care.js` — это эндпоинт списка назначений. Скорее всего у него внутри SELECT из `home_care_prescriptions p` с JOIN на `clients` / `users`.

- [ ] **Step 2: Заменить SELECT на версию с adherence**

Заменить тело хэндлера на (имя переменной `rows` оставить как было; если в существующем коде имя другое — адаптировать):

```js
router.get('/', authMiddleware, async (req, res) => {
  try {
    const rows = await db.any(
      `WITH prescriptions AS (
         SELECT p.id, p.created_at, p.updated_at, p.client_id, p.specialist_id,
                p.notes, p.start_date, p.end_date, p.record_id,
                c.full_name AS client_name,
                u.name      AS specialist_name
           FROM home_care_prescriptions p
           LEFT JOIN clients c ON c.id = p.client_id
           LEFT JOIN users   u ON u.id = p.specialist_id
          WHERE p.salon_id = $1
       )
       SELECT
         pr.*,
         (SELECT COUNT(*) FROM home_care_items i
            WHERE i.prescription_id = pr.id
              AND i.time_of_day IN ('morning','evening','additional')) AS hc_items_count,
         (
           WITH days AS (
             SELECT generate_series(
               pr.start_date,
               LEAST(COALESCE(pr.end_date, CURRENT_DATE), CURRENT_DATE),
               '1 day'::interval
             )::date AS d
           ),
           expected AS (
             SELECT COUNT(*) AS n
               FROM days d
               JOIN home_care_items i ON i.prescription_id = pr.id
                                     AND i.time_of_day IN ('morning','evening','additional')
              WHERE i.days_of_week IS NULL
                 OR cardinality(i.days_of_week) = 0
                 OR (EXTRACT(ISODOW FROM d.d)::int - 1) = ANY(i.days_of_week)
           ),
           done AS (
             SELECT COUNT(*) AS n
               FROM home_care_completions c
               JOIN home_care_items i ON i.id = c.item_id
              WHERE i.prescription_id = pr.id
                AND i.time_of_day IN ('morning','evening','additional')
                AND c.client_id = pr.client_id
                AND c.completion_date BETWEEN
                      pr.start_date AND
                      LEAST(COALESCE(pr.end_date, CURRENT_DATE), CURRENT_DATE)
           )
           SELECT CASE
                    WHEN (SELECT n FROM expected) = 0 THEN NULL
                    ELSE ROUND(100.0 * (SELECT n FROM done) / (SELECT n FROM expected))::int
                  END
         ) AS adherence_pct
       FROM prescriptions pr
       ORDER BY pr.created_at DESC`,
      [req.user.salonId]
    );
    res.json({ success: true, prescriptions: rows });
  } catch (e) {
    console.error('[Home care list error]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

Если в существующем GET были дополнительные поля или фильтры (например по `client_id` через query) — сохранить их, добавив в WHERE главной CTE и в параметры. Ничего не выкидывать; цель — добавить колонку, не сломать существующий контракт.

- [ ] **Step 3: Перезапустить**

```bash
pm2 restart loyalpro && sleep 2 && pm2 logs loyalpro --lines 20 --nostream
```

Ожидаемо: без ошибок.

- [ ] **Step 4: Проверить вычисление adherence на любом существующем prescription**

```bash
node -e "
const {db} = require('/root/loyalpro/backend/db');
(async () => {
  const r = await db.any(\`
    SELECT id, start_date, end_date,
      (SELECT COUNT(*) FROM home_care_items i WHERE i.prescription_id = p.id) AS items
    FROM home_care_prescriptions p ORDER BY id DESC LIMIT 3
  \`);
  console.log(r);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
```

Затем дёрнуть GET (нужен admin-токен), убедиться, что в JSON каждой строки есть `adherence_pct` (число или null):

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/home-care \
  | head -c 500
```

Ожидаемо: в JSON у каждого prescription поле `adherence_pct`.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/routes/home-care.js
git commit -m "feat(home-care): compute adherence_pct in prescription list

Calculated against course period (start_date..min(end_date,today))
using days_of_week per item. Returns NULL when expected=0.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: home-care.js — start_date / end_date / days_of_week в GET-detail

**Files:**
- Modify: `/root/loyalpro/backend/routes/home-care.js`

- [ ] **Step 1: Найти GET-detail**

Найти `router.get('/:id'` в `home-care.js` (у него ниже уже есть `db.any('SELECT * FROM home_care_items WHERE prescription_id=$1 ...`).

- [ ] **Step 2: Убедиться, что SELECT prescription отдаёт start_date / end_date**

Если хэндлер делает `SELECT * FROM home_care_prescriptions ...` — после миграции Task 1 он автоматически вернёт новые колонки. Никаких правок не нужно.

Если SELECT перечисляет колонки явно — добавить `start_date, end_date` в список.

- [ ] **Step 3: Убедиться, что SELECT items отдаёт days_of_week**

Найти `SELECT * FROM home_care_items WHERE prescription_id=$1 ORDER BY time_of_day, sort_order`. Если используется `*` — `days_of_week` уже отдаётся. Если перечисление — добавить `days_of_week`.

- [ ] **Step 4: Smoke-тест**

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/home-care/<existing_id> | head -c 500
```

Ожидаемо: в JSON есть `start_date` / `end_date` (на верхнем уровне) и у каждого item — `days_of_week` (массив или null).

- [ ] **Step 5: Commit (если были правки)**

Если правки потребовались:

```bash
cd /root/loyalpro && git add backend/routes/home-care.js
git commit -m "feat(home-care): expose start_date/end_date/days_of_week in detail

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Если правок не потребовалось (всё через `SELECT *`) — пропустить commit. Шаг закрыт автоматически.

---

## Task 5: home-care.js — новый эндпоинт adherence-history (heatmap для админки)

**Files:**
- Modify: `/root/loyalpro/backend/routes/home-care.js`

- [ ] **Step 1: Добавить эндпоинт перед `module.exports = router;`**

В конце файла перед `module.exports = router;` вставить:

```js
// GET /api/home-care/:id/adherence-history[?date=YYYY-MM-DD]
// Heatmap data for admin: per-day expected/completed for the course range.
// If `date` query is given, also returns items_for_day for that date.
router.get('/:id/adherence-history', authMiddleware, async (req, res) => {
  try {
    const presc = await db.oneOrNone(
      `SELECT id, salon_id, client_id, start_date, end_date
         FROM home_care_prescriptions
        WHERE id = $1 AND salon_id = $2`,
      [req.params.id, req.user.salonId]
    );
    if (!presc) return res.status(404).json({ error: 'Назначение не найдено' });

    const itemsCount = await db.one(
      `SELECT COUNT(*)::int AS n FROM home_care_items
        WHERE prescription_id = $1
          AND time_of_day IN ('morning','evening','additional')`,
      [presc.id]
    );

    const days = await db.any(
      `WITH days AS (
         SELECT generate_series(
           $1::date,
           LEAST(COALESCE($2::date, CURRENT_DATE), CURRENT_DATE),
           '1 day'::interval
         )::date AS d
       )
       SELECT
         d.d AS date,
         (
           SELECT COUNT(*)::int FROM home_care_items i
            WHERE i.prescription_id = $3
              AND i.time_of_day IN ('morning','evening','additional')
              AND (i.days_of_week IS NULL
                   OR cardinality(i.days_of_week) = 0
                   OR (EXTRACT(ISODOW FROM d.d)::int - 1) = ANY(i.days_of_week))
         ) AS expected,
         (
           SELECT COUNT(*)::int FROM home_care_completions c
            JOIN home_care_items i ON i.id = c.item_id
            WHERE i.prescription_id = $3
              AND c.client_id      = $4
              AND c.completion_date = d.d
              AND i.time_of_day IN ('morning','evening','additional')
         ) AS completed
       FROM days d
       ORDER BY d.d`,
      [presc.start_date, presc.end_date, presc.id, presc.client_id]
    );

    const response = {
      prescription: {
        id: presc.id,
        start_date: presc.start_date,
        end_date:   presc.end_date,
        items_count: itemsCount.n,
      },
      days,
    };

    if (req.query.date) {
      const dateStr = String(req.query.date);
      // YYYY-MM-DD только; не доверяем входу
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return res.status(400).json({ error: 'Неверный формат date (нужно YYYY-MM-DD)' });
      }
      response.items_for_day = await db.any(
        `SELECT
           i.id,
           i.time_of_day,
           i.product_name,
           i.instructions,
           CASE WHEN c.id IS NOT NULL THEN true ELSE false END AS completed,
           c.completed_at
         FROM home_care_items i
         LEFT JOIN home_care_completions c
                ON c.item_id  = i.id
               AND c.client_id = $1
               AND c.completion_date = $2::date
         WHERE i.prescription_id = $3
           AND i.time_of_day IN ('morning','evening','additional')
           AND (i.days_of_week IS NULL
                OR cardinality(i.days_of_week) = 0
                OR (EXTRACT(ISODOW FROM $2::date)::int - 1) = ANY(i.days_of_week))
         ORDER BY
           CASE i.time_of_day
             WHEN 'morning' THEN 1
             WHEN 'evening' THEN 2
             WHEN 'additional' THEN 3
           END,
           i.sort_order`,
        [presc.client_id, dateStr, presc.id]
      );
    }

    res.json({ success: true, ...response });
  } catch (e) {
    console.error('[Adherence history error]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Перезапустить и проверить**

```bash
pm2 restart loyalpro && sleep 2 && pm2 logs loyalpro --lines 20 --nostream
```

Ожидаемо: без ошибок.

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/home-care/<id>/adherence-history" | head -c 500
```

Ожидаемо: JSON с `prescription` и массивом `days` за период курса (каждый день — `{date, expected, completed}`).

- [ ] **Step 3: Smoke-тест с date-фильтром**

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/home-care/<id>/adherence-history?date=2026-05-05" | head -c 600
```

Ожидаемо: тот же ответ + поле `items_for_day` с массивом item-ов.

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro && git add backend/routes/home-care.js
git commit -m "feat(home-care): add adherence-history endpoint for admin heatmap

GET /api/home-care/:id/adherence-history returns per-day expected/completed
counts across the course period. With ?date=YYYY-MM-DD also returns
items_for_day for the day-detail panel under the calendar.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: mobile-client.js — GET /today-checklist

**Files:**
- Modify: `/root/loyalpro/backend/routes/mobile-client.js`

- [ ] **Step 1: Открыть файл и найти подходящее место**

В `routes/mobile-client.js` найти строку `module.exports = router;` (последняя строка). Все новые эндпоинты вставлять перед ней.

- [ ] **Step 2: Вставить эндпоинт**

Перед `module.exports = router;` вставить:

```js
// ─────────────────────────────────────────────────────────────
// Daily Care Checklist — Today
// ─────────────────────────────────────────────────────────────
router.get('/today-checklist', mobileAuth, async (req, res) => {
  try {
    const rows = await db.any(
      `SELECT
         i.id,
         i.time_of_day                       AS "timeOfDay",
         i.product_name                      AS "productName",
         i.instructions,
         i.sort_order                        AS "sortOrder",
         p.id                                AS "prescriptionId",
         EXISTS (
           SELECT 1 FROM home_care_completions c
            WHERE c.item_id = i.id
              AND c.client_id = $1
              AND c.completion_date = CURRENT_DATE
         )                                   AS completed
       FROM home_care_items i
       JOIN home_care_prescriptions p ON p.id = i.prescription_id
       WHERE p.client_id = $1
         AND i.time_of_day IN ('morning','evening','additional')
         AND CURRENT_DATE BETWEEN p.start_date
                              AND COALESCE(p.end_date, '9999-12-31'::date)
         AND (
           i.days_of_week IS NULL
           OR cardinality(i.days_of_week) = 0
           OR (EXTRACT(ISODOW FROM CURRENT_DATE)::int - 1) = ANY(i.days_of_week)
         )
       ORDER BY
         CASE i.time_of_day
           WHEN 'morning'    THEN 1
           WHEN 'evening'    THEN 2
           WHEN 'additional' THEN 3
         END,
         i.sort_order`,
      [req.client.clientId]
    );

    const sections = { morning: [], evening: [], additional: [] };
    let completedCount = 0;
    for (const r of rows) {
      const sec = r.timeOfDay;
      if (!sections[sec]) continue;
      sections[sec].push({
        id:             r.id,
        productName:    r.productName,
        instructions:   r.instructions,
        completed:      r.completed,
        prescriptionId: r.prescriptionId,
      });
      if (r.completed) completedCount += 1;
    }

    res.json({
      success: true,
      date: new Date().toISOString().slice(0, 10),
      sections,
      summary: { total: rows.length, completed: completedCount },
    });
  } catch (e) {
    console.error('[Today checklist error]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 3: Перезапустить и проверить**

```bash
pm2 restart loyalpro && sleep 2 && pm2 logs loyalpro --lines 20 --nostream
```

Если у тебя есть мобильный JWT (`MOBILE_TOKEN`):

```bash
curl -fsS -H "Authorization: Bearer $MOBILE_TOKEN" \
  http://localhost:3000/api/mobile/client/today-checklist | head -c 800
```

Ожидаемо: JSON с полями `date`, `sections.morning/evening/additional`, `summary.total/completed`.

Если у клиента нет активных назначений — ответ должен быть валидным `{success:true, date:..., sections:{morning:[],evening:[],additional:[]}, summary:{total:0,completed:0}}`, не 500.

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro && git add backend/routes/mobile-client.js
git commit -m "feat(mobile-api): add GET /today-checklist endpoint

Aggregates active homecare items for today across all client's
prescriptions, grouped by morning/evening/additional, with
per-item completed flag and summary counters.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: mobile-client.js — POST/DELETE complete

**Files:**
- Modify: `/root/loyalpro/backend/routes/mobile-client.js`

- [ ] **Step 1: Вставить два эндпоинта перед `module.exports = router;`**

```js
// POST /api/mobile/client/today-checklist/items/:itemId/complete
// Mark today's item as done. Idempotent.
router.post('/today-checklist/items/:itemId/complete', mobileAuth, async (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId, 10);
    if (!Number.isInteger(itemId)) {
      return res.status(400).json({ error: 'Bad itemId' });
    }

    // Берём prescription и расписание item за один запрос
    const row = await db.oneOrNone(
      `SELECT i.id, i.time_of_day, i.days_of_week,
              p.client_id, p.start_date, p.end_date
         FROM home_care_items i
         JOIN home_care_prescriptions p ON p.id = i.prescription_id
        WHERE i.id = $1`,
      [itemId]
    );
    if (!row) return res.status(404).json({ error: 'Item not found' });
    if (row.client_id !== req.client.clientId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!['morning', 'evening', 'additional'].includes(row.time_of_day)) {
      return res.status(400).json({ error: 'Item is not in checklist' });
    }

    // Проверка периода курса
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(row.start_date); start.setHours(0, 0, 0, 0);
    const end   = row.end_date ? new Date(row.end_date) : null;
    if (end) end.setHours(0, 0, 0, 0);
    if (today < start || (end && today > end)) {
      return res.status(400).json({ error: 'Out of course period' });
    }

    // Проверка дня недели
    const isodow = ((today.getDay() + 6) % 7); // 0=Пн..6=Вс
    const days = row.days_of_week;
    const fitsDay =
      !days || days.length === 0 || days.length === 7 || days.includes(isodow);
    if (!fitsDay) {
      return res.status(400).json({ error: 'Not scheduled for today' });
    }

    await db.none(
      `INSERT INTO home_care_completions (item_id, client_id, completion_date)
       VALUES ($1, $2, CURRENT_DATE)
       ON CONFLICT (item_id, client_id, completion_date) DO NOTHING`,
      [itemId, req.client.clientId]
    );

    res.json({ success: true, completed: true });
  } catch (e) {
    console.error('[Mark complete error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/mobile/client/today-checklist/items/:itemId/complete
// Unmark today's item. Cannot affect past dates.
router.delete('/today-checklist/items/:itemId/complete', mobileAuth, async (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId, 10);
    if (!Number.isInteger(itemId)) {
      return res.status(400).json({ error: 'Bad itemId' });
    }
    // Проверим, что item принадлежит prescription клиента (не удаляем чужое)
    const owns = await db.oneOrNone(
      `SELECT 1 FROM home_care_items i
         JOIN home_care_prescriptions p ON p.id = i.prescription_id
        WHERE i.id = $1 AND p.client_id = $2`,
      [itemId, req.client.clientId]
    );
    if (!owns) return res.status(403).json({ error: 'Forbidden' });

    await db.none(
      `DELETE FROM home_care_completions
        WHERE item_id = $1 AND client_id = $2 AND completion_date = CURRENT_DATE`,
      [itemId, req.client.clientId]
    );

    res.json({ success: true, completed: false });
  } catch (e) {
    console.error('[Unmark complete error]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Перезапустить и проверить**

```bash
pm2 restart loyalpro && sleep 2 && pm2 logs loyalpro --lines 20 --nostream
```

С мобильным токеном (требуется существующий item с прав. расписанием на сегодня):

```bash
curl -fsS -X POST -H "Authorization: Bearer $MOBILE_TOKEN" \
  http://localhost:3000/api/mobile/client/today-checklist/items/<itemId>/complete | head -c 200
```

Ожидаемо: `{"success":true,"completed":true}`.

```bash
curl -fsS -X DELETE -H "Authorization: Bearer $MOBILE_TOKEN" \
  http://localhost:3000/api/mobile/client/today-checklist/items/<itemId>/complete | head -c 200
```

Ожидаемо: `{"success":true,"completed":false}`.

Проверить идемпотентность:

```bash
# Двойной POST — без ошибок
curl -fsS -X POST -H "Authorization: Bearer $MOBILE_TOKEN" \
  http://localhost:3000/api/mobile/client/today-checklist/items/<itemId>/complete
curl -fsS -X POST -H "Authorization: Bearer $MOBILE_TOKEN" \
  http://localhost:3000/api/mobile/client/today-checklist/items/<itemId>/complete
# В БД должна быть одна строка
node -e "
const {db} = require('/root/loyalpro/backend/db');
db.any('SELECT * FROM home_care_completions WHERE item_id=\$1 AND completion_date=CURRENT_DATE', [<itemId>])
  .then(r => { console.log(r); process.exit(0); });
"
```

Ожидаемо: ровно одна строка.

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro && git add backend/routes/mobile-client.js
git commit -m "feat(mobile-api): POST/DELETE today's item completion

Idempotent insert via ON CONFLICT. DELETE constrained to CURRENT_DATE
so past days cannot be modified — implements the 'after midnight a day
becomes a fact' rule from the spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: mobile-client.js — GET /prescriptions/:id/adherence

**Files:**
- Modify: `/root/loyalpro/backend/routes/mobile-client.js`

- [ ] **Step 1: Вставить эндпоинт перед `module.exports = router;`**

```js
// GET /api/mobile/client/prescriptions/:id/adherence
// Heatmap data for the patient (no items_for_day breakdown).
router.get('/prescriptions/:id/adherence', mobileAuth, async (req, res) => {
  try {
    const presc = await db.oneOrNone(
      `SELECT id, start_date, end_date
         FROM home_care_prescriptions
        WHERE id = $1 AND client_id = $2`,
      [req.params.id, req.client.clientId]
    );
    if (!presc) return res.status(404).json({ error: 'Назначение не найдено' });

    const days = await db.any(
      `WITH days AS (
         SELECT generate_series(
           $1::date,
           LEAST(COALESCE($2::date, CURRENT_DATE), CURRENT_DATE),
           '1 day'::interval
         )::date AS d
       )
       SELECT
         d.d AS date,
         (
           SELECT COUNT(*)::int FROM home_care_items i
            WHERE i.prescription_id = $3
              AND i.time_of_day IN ('morning','evening','additional')
              AND (i.days_of_week IS NULL
                   OR cardinality(i.days_of_week) = 0
                   OR (EXTRACT(ISODOW FROM d.d)::int - 1) = ANY(i.days_of_week))
         ) AS expected,
         (
           SELECT COUNT(*)::int FROM home_care_completions c
            JOIN home_care_items i ON i.id = c.item_id
            WHERE i.prescription_id = $3
              AND c.client_id      = $4
              AND c.completion_date = d.d
              AND i.time_of_day IN ('morning','evening','additional')
         ) AS completed
       FROM days d
       ORDER BY d.d`,
      [presc.start_date, presc.end_date, presc.id, req.client.clientId]
    );

    const totals = days.reduce(
      (acc, d) => ({ expected: acc.expected + d.expected, completed: acc.completed + d.completed }),
      { expected: 0, completed: 0 }
    );
    const adherencePct = totals.expected === 0
      ? null
      : Math.round((100 * totals.completed) / totals.expected);

    res.json({
      success: true,
      prescription: {
        id:           presc.id,
        startDate:    presc.start_date,
        endDate:      presc.end_date,
        adherencePct,
        completed:    totals.completed,
        expected:     totals.expected,
      },
      days,
    });
  } catch (e) {
    console.error('[Patient adherence error]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Перезапустить и проверить**

```bash
pm2 restart loyalpro && sleep 2 && pm2 logs loyalpro --lines 20 --nostream
```

```bash
curl -fsS -H "Authorization: Bearer $MOBILE_TOKEN" \
  http://localhost:3000/api/mobile/client/prescriptions/<id>/adherence | head -c 800
```

Ожидаемо: JSON с `prescription.adherencePct` (число или null), `days[]`. Длина `days` = число дней от `start_date` до `min(end_date, today)`.

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro && git add backend/routes/mobile-client.js
git commit -m "feat(mobile-api): add GET /prescriptions/:id/adherence

Returns per-day expected/completed array plus aggregated adherence_pct.
Mirrors admin heatmap endpoint but scoped to client's own prescription.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: mobile-client.js — расширить GET /prescriptions/:id

**Files:**
- Modify: `/root/loyalpro/backend/routes/mobile-client.js`

- [ ] **Step 1: Найти существующий обработчик**

В `routes/mobile-client.js` найти `router.get('/prescriptions/:id'`, добавленный планом prescriptions. Сейчас он SELECT'ит prescription с `created_at`, `notes`, `specialistName`, `specialistRole`, плюс items.

- [ ] **Step 2: Расширить SELECT prescription — добавить даты курса**

Заменить SELECT prescription на:

```js
    const p = await db.oneOrNone(
      `SELECT
        p.id,
        p.created_at AS "createdAt",
        p.notes,
        p.start_date AS "startDate",
        p.end_date   AS "endDate",
        u.name       AS "specialistName",
        u.role       AS "specialistRole"
       FROM home_care_prescriptions p
       LEFT JOIN users u ON u.id = p.specialist_id
       WHERE p.id = $1 AND p.client_id = $2`,
      [req.params.id, req.client.clientId]
    );
    if (!p) return res.status(404).json({ error: 'Назначение не найдено' });
```

- [ ] **Step 3: Расширить SELECT items — добавить days_of_week и completedToday**

Заменить SELECT items на:

```js
    const items = await db.any(
      `SELECT
         i.time_of_day  AS "timeOfDay",
         i.id,
         i.category,
         i.product_name AS "productName",
         i.instructions,
         i.sort_order   AS "sortOrder",
         i.days_of_week AS "daysOfWeek",
         CASE
           WHEN i.time_of_day IN ('morning','evening','additional')
            AND EXISTS (
              SELECT 1 FROM home_care_completions c
               WHERE c.item_id = i.id
                 AND c.client_id = $2
                 AND c.completion_date = CURRENT_DATE
            )
           THEN true ELSE false
         END AS "completedToday"
       FROM home_care_items i
       WHERE i.prescription_id = $1
       ORDER BY i.sort_order`,
      [req.params.id, req.client.clientId]
    );
    res.json({ success: true, prescription: { ...p, items } });
```

- [ ] **Step 4: Перезапустить и проверить**

```bash
pm2 restart loyalpro && sleep 2 && pm2 logs loyalpro --lines 20 --nostream

curl -fsS -H "Authorization: Bearer $MOBILE_TOKEN" \
  http://localhost:3000/api/mobile/client/prescriptions/<id> | head -c 1000
```

Ожидаемо: в ответе есть `prescription.startDate`, `prescription.endDate`, у каждого item — `daysOfWeek` и `completedToday`.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/routes/mobile-client.js
git commit -m "feat(mobile-api): expose course dates and completedToday in prescription detail

startDate/endDate at top level, daysOfWeek + completedToday per item.
completedToday is only true for homecare time_of_day values.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Админка — блок «Период курса» в форме

**Files:**
- Modify: `/root/loyalpro/frontend/js/pages/home-care.js`

- [ ] **Step 1: Открыть файл и сориентироваться**

`/root/loyalpro/frontend/js/pages/home-care.js` — vanilla JS, ~605 строк. Внутри:
- функция, рендерящая форму создания/редактирования (поиск по `face_procedures`/`body_procedures` или `<select>` клиента);
- функция `hcAddItem(timeOfDay, category, product, instructions, isService)` — добавляет item-строку;
- функция, собирающая `items` для отправки (поиск по `time_of_day: timeOfDay, category, product_name`).

- [ ] **Step 2: Добавить HTML-блок «Период курса»**

В шаблоне формы (HTML-строка перед секциями Утро/Вечер/…) сразу после поля «Заметки» добавить:

```html
<div class="hc-period">
  <h3>Период курса</h3>
  <div class="hc-period-row">
    <label>Начало:
      <input type="date" id="hcStartDate" required>
    </label>
    <label>Окончание:
      <input type="date" id="hcEndDate">
    </label>
    <label class="hc-open-ended">
      <input type="checkbox" id="hcOpenEnded">
      <span>Бессрочно</span>
    </label>
  </div>
  <div class="hc-period-error" id="hcPeriodError" style="display:none;color:#c33;font-size:13px;margin-top:6px;"></div>
</div>
```

Стили блока (минимальные, можно вписать в существующий `<style>` или в css-файл админки):

```css
.hc-period { margin-bottom: 16px; padding: 12px; background:#f8f6f0; border-radius:8px; }
.hc-period h3 { margin:0 0 8px 0; font-size:14px; color:#4A4540; }
.hc-period-row { display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
.hc-period-row label { font-size:13px; color:#4A4540; display:flex; align-items:center; gap:6px; }
.hc-period-row input[type=date] { padding:4px 8px; border:1px solid #d0c8b8; border-radius:4px; }
.hc-period-row input[type=date]:disabled { background:#eee; color:#999; }
.hc-open-ended { gap:4px !important; }
```

- [ ] **Step 3: Подключить поведение чекбокса «Бессрочно»**

В функции, которая привязывает обработчики формы (после рендера), добавить:

```js
const hcStartDateEl = document.getElementById('hcStartDate');
const hcEndDateEl   = document.getElementById('hcEndDate');
const hcOpenEndedEl = document.getElementById('hcOpenEnded');

// дефолт start = сегодня
if (!hcStartDateEl.value) {
  hcStartDateEl.value = new Date().toISOString().slice(0, 10);
}

hcOpenEndedEl.addEventListener('change', () => {
  if (hcOpenEndedEl.checked) {
    hcEndDateEl.value = '';
    hcEndDateEl.disabled = true;
  } else {
    hcEndDateEl.disabled = false;
  }
});
```

- [ ] **Step 4: При редактировании существующего prescription — заполнить поля**

В функции, которая получает данные prescription (по `GET /api/home-care/:id`) и заполняет форму, после установки полей добавить:

```js
if (data.prescription) {
  const pr = data.prescription;
  if (pr.start_date) hcStartDateEl.value = String(pr.start_date).slice(0, 10);
  if (pr.end_date) {
    hcEndDateEl.value = String(pr.end_date).slice(0, 10);
    hcOpenEndedEl.checked = false;
    hcEndDateEl.disabled  = false;
  } else {
    hcEndDateEl.value = '';
    hcOpenEndedEl.checked = true;
    hcEndDateEl.disabled  = true;
  }
}
```

(Имя переменной с ответом сервера может отличаться — сверь с существующим кодом загрузки.)

- [ ] **Step 5: Валидация перед отправкой и включение в payload**

В функции, собирающей payload для POST/PUT (поиск по `JSON.stringify` или `body: JSON.stringify`), перед отправкой:

```js
const startDate = hcStartDateEl.value;
const endDate   = hcOpenEndedEl.checked ? null : (hcEndDateEl.value || null);
const errEl = document.getElementById('hcPeriodError');
errEl.style.display = 'none';
errEl.textContent = '';

if (!startDate) {
  errEl.textContent = 'Укажите дату начала курса';
  errEl.style.display = 'block';
  return;
}
if (endDate && endDate < startDate) {
  errEl.textContent = 'Дата окончания не может быть раньше начала';
  errEl.style.display = 'block';
  return;
}
```

Затем в существующем объекте payload добавить:

```js
const payload = {
  // ... существующие поля ...
  start_date: startDate,
  end_date:   endDate,
};
```

- [ ] **Step 6: Smoke-тест в админке**

Открыть админку в браузере → создать новое назначение домашнего ухода → выбрать клиента, добавить item, заполнить «Начало» и «Окончание» → сохранить → проверить в БД:

```bash
node -e "
const {db} = require('/root/loyalpro/backend/db');
db.any('SELECT id, start_date, end_date FROM home_care_prescriptions ORDER BY id DESC LIMIT 1')
  .then(r => { console.log(r); process.exit(0); });
"
```

Ожидаемо: новая строка с заполненными `start_date` и `end_date`.

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro && git add frontend/js/pages/home-care.js
git commit -m "feat(admin): add course period block to home-care form

Two date inputs (start/end) and 'Бессрочно' checkbox toggling end_date.
Validates start required and end >= start before submit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Админка — дни недели на каждом item

**Files:**
- Modify: `/root/loyalpro/frontend/js/pages/home-care.js`

- [ ] **Step 1: Найти `hcAddItem`**

Функция `hcAddItem(timeOfDay, category, product = '', instructions = '', isService = false)` рендерит item-строку. Сейчас она вставляет в DOM что-то вроде:

```html
<div class="hc-item-row">
  <input type="text" placeholder="..." data-field="product_name" value="...">
  <input type="text" placeholder="Как применять, частота..." data-field="instructions" value="...">
  <button class="hc-remove">×</button>
</div>
```

- [ ] **Step 2: Расширить рендер item-строки**

Заменить тело `hcAddItem` на (сохрани существующую логику добавления в категорию — меняется только HTML row):

```js
function hcAddItem(timeOfDay, category, product = '', instructions = '', isService = false, daysOfWeek = null) {
  const catId = `hcCat-${timeOfDay}-${category}`;
  // ... существующая логика создания/получения контейнера категории ...
  // (оставить как было — здесь меняется только то, что вставляется внутрь)

  const isHomecare = ['morning', 'evening', 'additional'].includes(timeOfDay);
  const days = Array.isArray(daysOfWeek) ? daysOfWeek : null;

  const row = document.createElement('div');
  row.className = 'hc-item-row';
  row.innerHTML = `
    <div class="hc-item-fields">
      <input type="text" placeholder="${isService ? 'Процедура' : 'Косметика / препарат'}"
             value="${esc(product)}" data-field="product_name">
      <input type="text" placeholder="Как применять, частота..."
             value="${esc(instructions)}" data-field="instructions">
      <button type="button" class="hc-remove" title="Удалить">×</button>
    </div>
    ${isHomecare ? `
      <div class="hc-days" data-field="days_of_week">
        ${[
          ['Пн', 0], ['Вт', 1], ['Ср', 2], ['Чт', 3],
          ['Пт', 4], ['Сб', 5], ['Вс', 6],
        ].map(([label, idx]) => {
          const active = days === null || days.includes(idx);
          return `<button type="button" class="hc-day ${active ? 'active' : ''}"
                          data-day="${idx}">${label}</button>`;
        }).join('')}
        <button type="button" class="hc-day-all">Каждый день</button>
      </div>
    ` : ''}
  `;

  // обработчики
  row.querySelector('.hc-remove').addEventListener('click', () => row.remove());

  if (isHomecare) {
    row.querySelectorAll('.hc-day').forEach(btn => {
      btn.addEventListener('click', () => btn.classList.toggle('active'));
    });
    row.querySelector('.hc-day-all').addEventListener('click', () => {
      const all = row.querySelectorAll('.hc-day');
      const allActive = [...all].every(b => b.classList.contains('active'));
      all.forEach(b => b.classList.toggle('active', !allActive));
    });
  }

  // вставка в категорию (как было — твой существующий код)
  document.getElementById(catId).querySelector('.hc-cat-items').appendChild(row);
}
```

(Сохрани существующую обёртку категории — `hcAddItem` создаёт категорию при первом вызове через `hcCat-...`. Меняется только содержимое `.hc-item-row`.)

- [ ] **Step 3: Стили дней недели**

Добавить в css:

```css
.hc-item-row { display:flex; flex-direction:column; gap:6px; padding:8px 0; border-bottom:1px solid #efe9da; }
.hc-item-fields { display:flex; gap:8px; align-items:center; }
.hc-item-fields input { flex:1; padding:6px 8px; border:1px solid #d0c8b8; border-radius:4px; font-size:13px; }
.hc-item-fields .hc-remove { padding:4px 10px; border:none; background:#f4dede; color:#c33; border-radius:4px; cursor:pointer; font-size:16px; line-height:1; }

.hc-days { display:flex; gap:4px; flex-wrap:wrap; padding-left:2px; }
.hc-days .hc-day {
  padding:3px 10px; font-size:12px; cursor:pointer;
  border:1px solid #d0c8b8; border-radius:14px; background:#fff; color:#7A736B;
  min-width:36px; text-align:center;
}
.hc-days .hc-day.active { background:#D4AF37; border-color:#D4AF37; color:#fff; }
.hc-days .hc-day-all {
  padding:3px 12px; font-size:12px; cursor:pointer; margin-left:8px;
  border:1px dashed #c8b878; border-radius:14px; background:transparent; color:#7A736B;
}
```

- [ ] **Step 4: Передать days_of_week из загрузки**

Найти место, где после `GET /api/home-care/:id` существующий код вызывает `hcAddItem` для каждого item (поиск `hcAddItem(it.time_of_day, it.category, it.product_name, it.instructions, ...)`). Заменить на:

```js
hcAddItem(
  it.time_of_day, it.category, it.product_name,
  it.instructions, isService, it.days_of_week || null,
);
```

- [ ] **Step 5: Сборка `days_of_week` в payload**

В функции сборки items (поиск `items.push({time_of_day: ...})`):

```js
const collectDays = (row) => {
  const daysWrap = row.querySelector('[data-field="days_of_week"]');
  if (!daysWrap) return null;                       // не homecare — не отправляем
  const active = [...daysWrap.querySelectorAll('.hc-day.active')]
    .map(b => parseInt(b.dataset.day, 10))
    .sort((a, b) => a - b);
  if (active.length === 0 || active.length === 7) return null;  // = ежедневно
  return active;
};

// В цикле сборки items:
items.push({
  time_of_day: timeOfDay,
  category,
  product_name:  row.querySelector('[data-field="product_name"]').value.trim(),
  instructions:  row.querySelector('[data-field="instructions"]').value.trim(),
  days_of_week:  collectDays(row),
});
```

- [ ] **Step 6: Smoke-тест**

В админке: создать новое назначение → к одному item выбрать только Пн/Ср/Пт → сохранить. Проверить в БД:

```bash
node -e "
const {db} = require('/root/loyalpro/backend/db');
db.any('SELECT id, time_of_day, product_name, days_of_week FROM home_care_items WHERE prescription_id = (SELECT MAX(id) FROM home_care_prescriptions) ORDER BY id')
  .then(r => { console.log(r); process.exit(0); });
"
```

Ожидаемо: у выбранного item `days_of_week = [0, 2, 4]`. У других item с «все дни активны» — `null`.

Открыть тот же prescription в админке заново → убедиться, что при загрузке формы кнопки Пн/Ср/Пт активны, остальные не активны.

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro && git add frontend/js/pages/home-care.js
git commit -m "feat(admin): per-item days_of_week toggles in home-care form

Seven Mon-Sun pill buttons + 'Каждый день' shortcut. Only rendered for
morning/evening/additional. Empty/all-7 = NULL on submit (= daily).
Loads existing days_of_week when editing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Админка — колонка «% выполнения» в списке + кнопка «Подробно»

**Files:**
- Modify: `/root/loyalpro/frontend/js/pages/home-care.js`

- [ ] **Step 1: Найти рендер списка prescriptions**

В `home-care.js` найти функцию рендера списка (поиск по слову `prescriptions` после `await fetch('/api/home-care')` или подобному). Каждая строка обычно содержит дату, имя клиента, имя специалиста.

- [ ] **Step 2: Добавить колонку % и кнопку**

В шаблон каждой строки добавить:

```js
const adh = pr.adherence_pct;
const adhText  = adh === null || adh === undefined ? '—' : `${adh}%`;
const adhColor = adh === null || adh === undefined ? '#7A736B'
              : adh >= 80 ? '#2e8b57'
              : adh >= 50 ? '#c89c1e'
              : '#c33';
const periodText = pr.start_date
  ? `Курс: ${fmtDateRu(pr.start_date)} → ${pr.end_date ? fmtDateRu(pr.end_date) : 'бессрочно'}`
  : '';
```

(Хелпер `fmtDateRu`: `(d) => new Date(d).toLocaleDateString('ru-RU')`. Если такого хелпера в файле нет — добавь его в начало модуля.)

В HTML строки (внутри существующей разметки `<div class="hc-list-row">…</div>` или table-row, в зависимости от того, как сейчас сделано):

```html
<div class="hc-list-cell hc-list-period">${esc(periodText)}</div>
<div class="hc-list-cell hc-list-adh" style="color:${adhColor};font-weight:600">${adhText}</div>
<button type="button" class="hc-detail-btn" data-id="${pr.id}"
        ${adh === null || adh === undefined ? 'disabled' : ''}>Подробно</button>
```

- [ ] **Step 3: Привязать клик «Подробно»**

После рендера списка:

```js
document.querySelectorAll('.hc-detail-btn').forEach(btn => {
  btn.addEventListener('click', () => openAdherenceModal(parseInt(btn.dataset.id, 10)));
});
```

Функция `openAdherenceModal` будет реализована в Task 13. На этом шаге достаточно объявить заглушку:

```js
function openAdherenceModal(id) {
  alert(`Heatmap для назначения #${id} — будет реализована в Task 13`);
}
```

- [ ] **Step 4: Smoke-тест**

Открыть админку → раздел «Назначения» → убедиться, что у каждой строки появилась цифра % (или «—»), цвет совпадает с диапазоном, кнопка «Подробно» кликается и показывает alert.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add frontend/js/pages/home-care.js
git commit -m "feat(admin): adherence % column and Подробно button in list

Color: green ≥80, amber 50-79, red <50, neutral when null. Button is
disabled when adherence is null (course not started / expected=0).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Админка — модалка heatmap

**Files:**
- Modify: `/root/loyalpro/frontend/js/pages/home-care.js`

- [ ] **Step 1: Заменить заглушку `openAdherenceModal` на реальную функцию**

Заменить функцию из Task 12 Step 3 на:

```js
async function openAdherenceModal(prescriptionId) {
  const token = localStorage.getItem('token');
  const url = `/api/home-care/${prescriptionId}/adherence-history`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    alert('Не удалось загрузить данные выполнения');
    return;
  }
  const data = await res.json();
  renderAdherenceModal(data, prescriptionId);
}
```

- [ ] **Step 2: Добавить функцию `renderAdherenceModal`**

```js
function renderAdherenceModal(data, prescriptionId) {
  // Удалить предыдущую модалку, если была
  const old = document.getElementById('hcAdherenceModal');
  if (old) old.remove();

  const pr = data.prescription;
  const totalExpected  = data.days.reduce((a, d) => a + d.expected, 0);
  const totalCompleted = data.days.reduce((a, d) => a + d.completed, 0);
  const pct = totalExpected === 0 ? null : Math.round((100 * totalCompleted) / totalExpected);

  // Группировка дней по неделям (старт с понедельника той недели, в которой start_date)
  const start = new Date(pr.start_date);
  const startOfWeek = new Date(start);
  const isodow = (start.getDay() + 6) % 7;     // 0=Пн..6=Вс
  startOfWeek.setDate(start.getDate() - isodow);
  const dayMap = {};
  data.days.forEach(d => { dayMap[d.date] = d; });

  const weeks = [];
  const today = new Date(); today.setHours(0,0,0,0);
  const endRender = pr.end_date ? new Date(pr.end_date) : today;
  endRender.setHours(0,0,0,0);
  const lastRender = endRender < today ? endRender : today;

  for (let cur = new Date(startOfWeek); cur <= lastRender; cur.setDate(cur.getDate() + 7)) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(cur); d.setDate(cur.getDate() + i);
      const ds = d.toISOString().slice(0, 10);
      const inCourse = d >= start && d <= lastRender;
      week.push(inCourse ? (dayMap[ds] || { date: ds, expected: 0, completed: 0 }) : null);
    }
    weeks.push(week);
  }

  const cellColor = (cell) => {
    if (!cell) return 'transparent';
    if (cell.expected === 0)  return '#e6e2dc';
    const ratio = cell.completed / cell.expected;
    if (ratio === 0)   return '#f4d4d4';
    if (ratio < 0.5)   return '#f4e4b6';
    if (ratio < 1)     return '#f0c98a';
    return '#bee0bf';
  };

  const fmt = (d) => new Date(d).toLocaleDateString('ru-RU');

  const modal = document.createElement('div');
  modal.id = 'hcAdherenceModal';
  modal.className = 'hc-modal-overlay';
  modal.innerHTML = `
    <div class="hc-modal">
      <button class="hc-modal-close" type="button" aria-label="Закрыть">×</button>
      <div class="hc-modal-header">
        <div>Назначение № ${pr.id}</div>
        <div class="hc-modal-sub">
          Курс: ${fmt(pr.start_date)} → ${pr.end_date ? fmt(pr.end_date) : 'бессрочно'}
          · Пунктов: ${pr.items_count}
        </div>
        <div class="hc-modal-sub">
          Выполнено: <b>${pct === null ? '—' : pct + '%'}</b> (${totalCompleted} из ${totalExpected})
        </div>
      </div>

      <div class="hc-cal-header">
        ${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d => `<div>${d}</div>`).join('')}
      </div>
      <div class="hc-cal-grid">
        ${weeks.map(w => w.map(c => `
          <div class="hc-cal-cell"
               data-date="${c ? c.date : ''}"
               style="background:${cellColor(c)}; ${c ? 'cursor:pointer' : ''}"
               title="${c ? `${fmt(c.date)} · ${c.completed}/${c.expected}` : ''}">
          </div>
        `).join('')).join('')}
      </div>

      <div class="hc-cal-legend">
        <span><i style="background:#e6e2dc"></i> нет назначений</span>
        <span><i style="background:#f4d4d4"></i> 0%</span>
        <span><i style="background:#f4e4b6"></i> &lt;50%</span>
        <span><i style="background:#f0c98a"></i> &lt;100%</span>
        <span><i style="background:#bee0bf"></i> 100%</span>
      </div>

      <div id="hcDayDetail" class="hc-day-detail" style="display:none;"></div>
    </div>
  `;

  // Обработчики закрытия
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  modal.querySelector('.hc-modal-close').addEventListener('click', () => modal.remove());
  document.addEventListener('keydown', function onEsc(ev) {
    if (ev.key === 'Escape') {
      modal.remove();
      document.removeEventListener('keydown', onEsc);
    }
  });

  // Тап по дню → подгрузить items_for_day
  modal.querySelectorAll('.hc-cal-cell').forEach(el => {
    if (!el.dataset.date) return;
    el.addEventListener('click', async () => {
      const date = el.dataset.date;
      const token = localStorage.getItem('token');
      const r = await fetch(
        `/api/home-care/${prescriptionId}/adherence-history?date=${date}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r.ok) return;
      const d = await r.json();
      const detail = document.getElementById('hcDayDetail');
      const fmtTime = (t) => t ? new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
      const sectionLabel = (s) => ({ morning: 'Утро', evening: 'Вечер', additional: 'Доп.' }[s] || s);
      detail.innerHTML = `
        <h4>День: ${fmt(date)}</h4>
        ${(d.items_for_day || []).map(item => `
          <div class="hc-day-item">
            <span class="hc-day-section">${sectionLabel(item.time_of_day)}</span>
            <span class="hc-day-name">${esc(item.product_name)}</span>
            <span class="hc-day-status" style="color:${item.completed ? '#2e8b57' : '#c33'}">
              ${item.completed ? '✓ ' + fmtTime(item.completed_at) : '✗ Не выполнено'}
            </span>
          </div>
        `).join('') || '<div class="hc-day-empty">На этот день не было назначений</div>'}
      `;
      detail.style.display = 'block';
    });
  });

  document.body.appendChild(modal);
}
```

- [ ] **Step 3: Стили модалки**

Добавить в css:

```css
.hc-modal-overlay {
  position:fixed; inset:0; background:rgba(0,0,0,0.45);
  display:flex; align-items:center; justify-content:center; z-index:1000;
}
.hc-modal {
  background:#fff; border-radius:12px; padding:20px 24px;
  width:min(640px, 92vw); max-height:90vh; overflow:auto; position:relative;
}
.hc-modal-close {
  position:absolute; top:10px; right:14px; background:none; border:none;
  font-size:22px; cursor:pointer; color:#7A736B;
}
.hc-modal-header { margin-bottom:16px; }
.hc-modal-header > div:first-child { font-size:16px; font-weight:600; color:#4A4540; }
.hc-modal-sub { font-size:13px; color:#7A736B; margin-top:4px; }

.hc-cal-header { display:grid; grid-template-columns:repeat(7,1fr); gap:3px; margin-top:8px;
  font-size:11px; color:#7A736B; text-align:center; text-transform:uppercase; }
.hc-cal-grid   { display:grid; grid-template-columns:repeat(7,1fr); gap:3px; margin-top:4px; }
.hc-cal-cell   { aspect-ratio:1; border-radius:3px; }

.hc-cal-legend { display:flex; gap:12px; flex-wrap:wrap; font-size:12px;
  margin-top:12px; color:#7A736B; }
.hc-cal-legend span { display:flex; align-items:center; gap:6px; }
.hc-cal-legend i {
  display:inline-block; width:12px; height:12px; border-radius:2px;
  border:1px solid rgba(0,0,0,0.06);
}

.hc-day-detail { margin-top:16px; padding:12px; background:#f8f6f0; border-radius:8px; }
.hc-day-detail h4 { margin:0 0 8px 0; font-size:14px; color:#4A4540; }
.hc-day-item {
  display:flex; gap:10px; align-items:baseline; padding:4px 0; font-size:13px;
}
.hc-day-section { color:#7A736B; min-width:48px; font-size:12px; }
.hc-day-name    { flex:1; color:#4A4540; }
.hc-day-status  { font-size:12px; }
.hc-day-empty   { color:#7A736B; font-size:13px; }
```

- [ ] **Step 4: Smoke-тест в браузере**

В админке → список назначений → нажать «Подробно» на любой строке с не-null adherence_pct → убедиться:
- модалка открывается с шапкой и периодом курса;
- в календаре есть ячейки разных цветов (хотя бы серые «нет назначений», и красные «0%» — должны быть на старых prescription без отметок);
- клик по ячейке внутри курса показывает панель детализации с item-ами того дня;
- крестик / клик по фону / Esc закрывают модалку.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add frontend/js/pages/home-care.js
git commit -m "feat(admin): heatmap modal with day-detail panel

Calendar grid (Mon-start) with 5 color levels by completed/expected ratio.
Click a cell -> fetch ?date=YYYY-MM-DD -> render items_for_day below.
Closes by ×, overlay click, or Esc.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (от секции 7 «Критерии приёмки»):**

- ✅ Период курса в форме (с/до, бессрочно) — Task 10
- ✅ Дни недели на каждом item — Task 11
- ✅ POST /complete и DELETE /complete — Task 7
- ✅ Запрет менять прошлые дни — Task 7 Step 1 (`completion_date = CURRENT_DATE` в DELETE WHERE)
- ✅ adherence_pct в списке — Task 3
- ✅ Кнопка «Подробно» + heatmap — Task 12 / Task 13
- ✅ Backfill старых prescription — Task 1 Step 2 (UPDATE start_date = DATE(created_at))
- ✅ Push НЕ реализован — нет соответствующих эндпоинтов или таблиц

**Spec coverage (по бэкенд-API из секции 3 спеки):**

- ✅ POST/PUT принимают start_date / end_date / days_of_week — Task 2
- ✅ GET list отдаёт adherence_pct — Task 3
- ✅ GET detail (admin) отдаёт start_date/end_date/days_of_week — Task 4
- ✅ GET /:id/adherence-history (с опц. ?date) — Task 5
- ✅ GET /mobile/today-checklist — Task 6
- ✅ POST/DELETE /mobile/today-checklist/items/:itemId/complete — Task 7
- ✅ GET /mobile/prescriptions/:id/adherence — Task 8
- ✅ GET /mobile/prescriptions/:id расширен — Task 9

**Placeholder scan:** Нет TBD/TODO. Все шаги содержат конкретные SQL/JS-блоки и команды проверки.

**Type/contract consistency:**

- `adherence_pct` (snake_case) везде в админ-API ✓
- `adherencePct` (camelCase) в моб. API ✓
- `days_of_week` SMALLINT[] в БД, на бэке нормализуется через `normalizeDays`, в моб. API отдаётся как `daysOfWeek` ✓
- `0=Пн..6=Вс` единая индексация: SQL (`EXTRACT(ISODOW)::int - 1`), JS на бэке (`(today.getDay() + 6) % 7`), JS в админке (массив `[['Пн',0]...['Вс',6]]`) ✓
- Категории чек-листа `('morning','evening','additional')` — везде идентичный фильтр ✓
- `completion_date = CURRENT_DATE` в DELETE — гарантия «нельзя править прошлое» ✓
