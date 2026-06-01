# Staff Personal Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать модуль «Личный дашборд специалиста» по спеке `docs/superpowers/specs/2026-06-01-staff-dashboard-design.md`. Сотрудник с ролью `specialist` видит свои метрики за период (визиты, выручка с разбивкой Услуги/Косметика/Абонементы, уник. клиенты, первичные, средний чек, топ-5 услуг, дневной график). Owner/admin продолжают видеть клинический дашборд без изменений.

**Architecture:** Один новый эндпоинт `GET /api/analytics/staff-dashboard` (изолирован от существующего `/dashboard`) + одна новая страница `staff-dashboard.js`. Привязка `users.staff_member_id` (новая колонка) — устанавливается админом в карточке пользователя.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg` pool), vanilla JS SPA (без сборки), Jest (unit).

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `backend/migrations.js` | Modify | + `users.staff_member_id` колонка + индекс |
| `backend/config.js` | Modify | + `/api/analytics/staff-dashboard` в `SPECIALIST_ALLOWED_PREFIXES` |
| `backend/routes/api.js` | Modify | + `router.get('/analytics/staff-dashboard', ...)` |
| `backend/services/staff-dashboard.js` | **Create** | Pure helpers: `aggregateRevenueByCategory`, `computeAvgCheck` (+ unit-тесты) |
| `backend/staff-dashboard-helpers.test.js` | **Create** | Jest unit tests для чистых функций |
| `backend/routes/users.js` | Modify | + поле `staff_member_id` в POST/PUT, JOIN на staff_members в GET-листе |
| `backend/routes/staff.js` | Modify | (если нужно) расширить GET staff-profiles полем `linked_to_user_id` для UI селектора |
| `backend/scripts/staff-dashboard-smoke.js` | **Create** | End-to-end smoke на dev: сессия → API → проверка формы ответа |
| `frontend/index.html` | Modify | + контейнер `<section id="page-staff-dashboard">` + пункт меню (role-aware) |
| `frontend/js/core/nav.js` | Modify | route `#staff-dashboard` → `loadStaffDashboard()`; role-aware пункт «Дашборд» |
| `frontend/js/pages/staff-dashboard.js` | **Create** | Страница: селектор периода, 6 карточек, график, топ-5 |
| `frontend/js/pages/users.js` | Modify | Селектор `staff_member_id` в форме редактирования (видим при роли specialist) |
| `frontend/css/base.css` | Modify | Минимум новых стилей (переиспользуем `.sc/.sg/.sl/.sv/.sd` главного дашборда) |

---

## Pre-flight

Никаких новых внешних сервисов / ключей не требуется. Можно стартовать сразу с Task 1.

---

## Task 1: DB migration — `users.staff_member_id`

**Files:**
- Modify: `backend/migrations.js`

- [ ] **Step 1:** Найти конец `runMigrations`:
  ```bash
  grep -n "^}$\|module.exports = { runMigrations" backend/migrations.js | tail -3
  ```
  Вставка — перед закрывающей `}` функции (по образцу прежних миграций).

- [ ] **Step 2:** Добавить блок:
  ```js
    // ── Personal Staff Dashboard ───────────────────────────────────
    // Спека: docs/superpowers/specs/2026-06-01-staff-dashboard-design.md
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS staff_member_id INTEGER
        REFERENCES staff_members(id) ON DELETE SET NULL
    `).catch(() => {});
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_staff_member
        ON users (staff_member_id) WHERE staff_member_id IS NOT NULL
    `).catch(() => {});
  ```

- [ ] **Step 3:** Прогон миграций локально:
  ```bash
  cd backend && node -e "
  const { runMigrations } = require('./migrations');
  const { pool } = require('./db');
  pool.connect().then(c => runMigrations(c).then(() => { c.release(); console.log('OK'); pool.end(); })).catch(e => { console.error(e); process.exit(1); });
  "
  ```
  Ожидается `OK`. Через `mcp__postgres__query` или прямой `node` проверить:
  ```sql
  SELECT column_name FROM information_schema.columns
  WHERE table_name='users' AND column_name='staff_member_id';
  ```
  Ожидается 1 строка.

- [ ] **Step 4:** Commit:
  ```bash
  git add backend/migrations.js
  git commit -m "feat(db): users.staff_member_id — привязка логина к YClients-сотруднику"
  ```

---

## Task 2: Pure helpers + failing tests (TDD red)

**Files:**
- Create: `backend/services/staff-dashboard.js`
- Create: `backend/staff-dashboard-helpers.test.js`

- [ ] **Step 1:** Создать тестовый файл `backend/staff-dashboard-helpers.test.js`:
  ```js
  'use strict';
  const { aggregateRevenueByCategory, computeAvgCheck } = require('./services/staff-dashboard');

  describe('aggregateRevenueByCategory', () => {
    test('заполняет три категории + total', () => {
      const rows = [
        { category: 'services',  total: '50000' },
        { category: 'goods',     total: '5000'  },
        { category: 'abonement', total: '10000' },
        { category: 'certificate', total: '999' },  // игнорируем
      ];
      expect(aggregateRevenueByCategory(rows)).toEqual({
        services: 50000, goods: 5000, abonement: 10000, total: 65000,
      });
    });
    test('недостающая категория — 0', () => {
      expect(aggregateRevenueByCategory([{ category: 'services', total: '1000' }])).toEqual({
        services: 1000, goods: 0, abonement: 0, total: 1000,
      });
    });
    test('пусто', () => {
      expect(aggregateRevenueByCategory([])).toEqual({ services: 0, goods: 0, abonement: 0, total: 0 });
      expect(aggregateRevenueByCategory(null)).toEqual({ services: 0, goods: 0, abonement: 0, total: 0 });
    });
  });

  describe('computeAvgCheck', () => {
    test.each([
      [10, 5000, 500],
      [0, 1000, 0],     // деление на ноль
      [1, 0, 0],
    ])('count=%i sum=%i → %i', (c, s, exp) => {
      expect(computeAvgCheck(c, s)).toBe(exp);
    });
    test('округление до целого', () => {
      expect(computeAvgCheck(3, 1000)).toBe(333);
    });
  });
  ```

- [ ] **Step 2:** Запустить — должно упасть (`Cannot find module`):
  ```bash
  cd backend && npx jest staff-dashboard-helpers
  ```

- [ ] **Step 3:** Commit:
  ```bash
  git add backend/staff-dashboard-helpers.test.js
  git commit -m "test: failing unit tests for staff-dashboard pure helpers"
  ```

---

## Task 3: Pure helpers (TDD green)

**Files:**
- Create: `backend/services/staff-dashboard.js`

- [ ] **Step 1:** Создать модуль:
  ```js
  'use strict';

  // Принимает строки из revenue_operations: [{category, total}],
  // возвращает {services, goods, abonement, total} с float и нулями для пропущенных.
  function aggregateRevenueByCategory(rows) {
    const out = { services: 0, goods: 0, abonement: 0, total: 0 };
    if (!Array.isArray(rows)) return out;
    for (const r of rows) {
      if (r.category in out && r.category !== 'total') {
        out[r.category] = parseFloat(r.total) || 0;
      }
    }
    out.total = out.services + out.goods + out.abonement;
    return out;
  }

  // Средний чек: округление до целого, ноль если count=0.
  function computeAvgCheck(count, sum) {
    const c = parseInt(count) || 0;
    const s = parseFloat(sum) || 0;
    return c > 0 ? Math.round(s / c) : 0;
  }

  module.exports = { aggregateRevenueByCategory, computeAvgCheck };
  ```

- [ ] **Step 2:** Прогон — должно стать зелёным:
  ```bash
  cd backend && npx jest staff-dashboard-helpers
  ```
  Ожидается 6 passed.

- [ ] **Step 3:** Commit:
  ```bash
  git add backend/services/staff-dashboard.js
  git commit -m "feat: pure helpers for staff-dashboard (aggregate + avg-check)"
  ```

---

## Task 4: Backend endpoint `/api/analytics/staff-dashboard`

**Files:**
- Modify: `backend/config.js`
- Modify: `backend/routes/api.js`

- [ ] **Step 1:** Обновить `SPECIALIST_ALLOWED_PREFIXES` в `backend/config.js`:
  ```js
  SPECIALIST_ALLOWED_PREFIXES: [
    '/api/home-care', '/api/auth', '/api/template-settings',
    '/api/patient-portfolio',
    '/api/analytics/staff-dashboard',   // ← новое
  ],
  ```

- [ ] **Step 2:** В `backend/routes/api.js` после `router.get('/analytics/dashboard', ...)` (≈стр. 170) вставить:
  ```js
  router.get('/analytics/staff-dashboard', auth, async (req, res) => {
    try {
      if (req.user.role !== 'specialist') return res.status(403).json({ error: 'forbidden' });
      const sid = req.user.salonId, uid = req.user.userId;
      const { from, to } = resolvePeriod(req);
      const link = await db.oneOrNone(`
        SELECT sm.yclients_staff_id, sm.name AS staff_name
        FROM users u JOIN staff_members sm ON sm.id = u.staff_member_id
        WHERE u.id = $1 AND sm.salon_id = $2
      `, [uid, sid]);
      if (!link) return res.json({ unlinked: true });

      const svc = require('../services/staff-dashboard');
      const yc = link.yclients_staff_id;
      const p = [sid, from, to, yc];

      const [rev, byCat, uniq, first, top, daily] = await Promise.all([
        db.one(`SELECT COUNT(*) AS rc, COALESCE(SUM(amount),0) AS rv FROM records r
                WHERE r.salon_id=$1 AND r.status IN ('completed','arrived')
                  AND COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) BETWEEN $2::date AND $3::date
                  AND (r.raw_payload->'staff'->0->>'id')::int = $4`, p),
        db.any(`SELECT category, COALESCE(SUM(amount),0) AS total FROM revenue_operations
                WHERE salon_id=$1 AND operation_date BETWEEN $2::date AND $3::date
                  AND (raw_payload->'staff'->0->>'id')::int = $4
                  AND category IN ('services','goods','abonement')
                GROUP BY category`, p),
        db.one(`SELECT COUNT(DISTINCT client_id) AS n FROM records r
                WHERE r.salon_id=$1 AND r.status IN ('completed','arrived')
                  AND COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) BETWEEN $2::date AND $3::date
                  AND (r.raw_payload->'staff'->0->>'id')::int = $4`, p),
        db.one(`WITH client_first AS (
                  SELECT client_id,
                         MIN(COALESCE((visit_datetime AT TIME ZONE 'Europe/Moscow')::date, visit_date::date)) AS d,
                         (ARRAY_AGG((raw_payload->'staff'->0->>'id') ORDER BY visit_date))[1]::int AS first_staff
                  FROM records WHERE salon_id=$1 AND status IN ('completed','arrived')
                    AND (raw_payload->>'paid_full')::int = 1
                  GROUP BY client_id)
                SELECT COUNT(*) AS n FROM client_first
                WHERE d BETWEEN $2::date AND $3::date AND first_staff = $4`, p),
        db.any(`SELECT svc->>'title' AS service_name, COUNT(DISTINCT r.id) AS cnt,
                       SUM((svc->>'cost_to_pay')::numeric) AS total_amount
                FROM records r, jsonb_array_elements(COALESCE(r.services,'[]'::jsonb)) svc
                WHERE r.salon_id=$1 AND r.status IN ('completed','arrived')
                  AND COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) BETWEEN $2::date AND $3::date
                  AND (r.raw_payload->'staff'->0->>'id')::int = $4
                  AND svc->>'title' IS NOT NULL
                GROUP BY 1 ORDER BY total_amount DESC NULLS LAST LIMIT 5`, p),
        db.any(`SELECT COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date)::text AS d,
                       COUNT(*) AS records, COALESCE(SUM(amount),0) AS revenue
                FROM records r
                WHERE r.salon_id=$1 AND r.status IN ('completed','arrived')
                  AND COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) BETWEEN $2::date AND $3::date
                  AND (r.raw_payload->'staff'->0->>'id')::int = $4
                GROUP BY 1 ORDER BY 1`, p),
      ]);

      const revenueByCategory = svc.aggregateRevenueByCategory(byCat);
      const periodRecords = parseInt(rev.rc);
      const periodRevenue = parseFloat(rev.rv);
      const avgCheck = svc.computeAvgCheck(periodRecords, periodRevenue);

      res.json({
        stats: {
          staffName: link.staff_name,
          periodRecords,
          periodRevenue,
          revenueByCategory,
          uniqueClients: parseInt(uniq.n),
          newClients: parseInt(first.n),
          avgCheck,
        },
        topServices: top,
        dailyRevenue: daily,
        period: { from, to },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  ```

- [ ] **Step 3:** Рестарт + быстрый smoke:
  ```bash
  pm2 restart loyalpro && sleep 2
  pm2 logs loyalpro --lines 10 --nostream | grep -i error || echo "no errors"
  ```

- [ ] **Step 4:** Commit:
  ```bash
  git add backend/config.js backend/routes/api.js
  git commit -m "feat(api): /analytics/staff-dashboard endpoint for role=specialist"
  ```

---

## Task 5: Users-API — поле `staff_member_id` в POST/PUT/GET

**Files:**
- Modify: `backend/routes/users.js`

- [ ] **Step 1:** Прочитать текущий `routes/users.js`, найти `router.post('/users'`, `router.put('/users/:id'`, `router.get('/users')`.

- [ ] **Step 2:** В POST/PUT:
  - Принимать поле `staff_member_id` (опциональное, integer или null).
  - Только для `role='specialist'`. Если другая роль — игнорировать или сбрасывать в NULL.
  - Валидация: если задан — `SELECT 1 FROM staff_members WHERE id=$1 AND salon_id=$2`, иначе 400.
  - Включить в INSERT/UPDATE.

- [ ] **Step 3:** В GET-листе пользователей: добавить JOIN на `staff_members` и в ответ — `staff_member_id`, `staff_member_name`:
  ```sql
  SELECT u.*, sm.name AS staff_member_name
  FROM users u LEFT JOIN staff_members sm ON sm.id = u.staff_member_id
  WHERE u.salon_id = $1
  ORDER BY u.created_at DESC
  ```

- [ ] **Step 4:** Рестарт. Curl-проверка через тестовый JWT:
  ```bash
  curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/users \
    | python3 -m json.tool | head -30
  ```
  Ожидается: каждый user-row имеет ключи `staff_member_id` (null или int) и `staff_member_name` (null или строка).

- [ ] **Step 5:** Commit:
  ```bash
  git add backend/routes/users.js
  git commit -m "feat(api): users — staff_member_id в POST/PUT/GET (для привязки логина к мастеру)"
  ```

---

## Task 6: Staff-list endpoint для UI селектора

**Files:**
- Modify: `backend/routes/staff.js` (расширить существующий `/staff-profiles`) — ИЛИ — создать новый `/staff-members` если расширять рискованно.

- [ ] **Step 1:** Открыть текущий `GET /staff-profiles`. Если возвращает уже `{id, name}` — добавить поле `linked_to_user_id`:
  ```sql
  SELECT sm.*, (SELECT u.id FROM users u WHERE u.staff_member_id = sm.id LIMIT 1) AS linked_to_user_id
  FROM staff_members sm WHERE sm.salon_id = $1 ORDER BY sm.name
  ```
  Иначе — добавить отдельный `GET /staff-members` с минимальным форматом `{id, name, linked_to_user_id}`.

- [ ] **Step 2:** Smoke через curl:
  ```bash
  curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/staff-profiles | python3 -m json.tool | head -20
  ```
  Ожидается: в каждой строке staff есть `linked_to_user_id` (null или user_id).

- [ ] **Step 3:** Commit:
  ```bash
  git add backend/routes/staff.js
  git commit -m "feat(api): staff-profiles — linked_to_user_id для UI привязки"
  ```

---

## Task 7: Frontend — Users UI: селектор привязки

**Files:**
- Modify: `frontend/js/pages/users.js`

- [ ] **Step 1:** В форме создания/редактирования пользователя:
  - Под полем «Роль» добавить блок, видимый ТОЛЬКО когда роль=`specialist`:
    ```html
    <div class="fg" id="staff-link-row" hidden>
      <label class="fl">Сотрудник YClients</label>
      <select class="fi" id="staff-link-select">
        <option value="">— не привязан —</option>
      </select>
      <div class="fh" id="staff-link-hint"></div>
    </div>
    ```
  - При смене селекта роли — toggle `hidden` блока.
  - При открытии формы — загрузить `GET /api/staff-profiles`, заполнить options. Для уже-привязанных other-юзеров — пометить серым `(привязан к: <name>)` и при выборе показать warning в `.fh`.

- [ ] **Step 2:** При сохранении — добавить `staff_member_id` (int or null) в body POST/PUT.

- [ ] **Step 3:** В списке пользователей рядом с ролью «Специалист» показать «→ Иванова А.А.» (из `staff_member_name`), если привязка есть.

- [ ] **Step 4:** Локально открыть «Пользователи» → создать тестового specialist → привязать → сохранить → перезагрузить страницу → убедиться, что привязка сохранилась.

- [ ] **Step 5:** Commit:
  ```bash
  git add frontend/js/pages/users.js
  git commit -m "feat(ui): users — селектор привязки к YClients-сотруднику для роли specialist"
  ```

---

## Task 8: Frontend — страница staff-dashboard + nav

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/core/nav.js`
- Create: `frontend/js/pages/staff-dashboard.js`
- Modify: `frontend/css/base.css` (минимум)

- [ ] **Step 1:** В `frontend/index.html` после контейнера `#page-dashboard` добавить:
  ```html
  <section id="page-staff-dashboard" class="page" hidden>
    <div class="sd-root"></div>
  </section>
  ```
  Нав-пункт «Дашборд» — оставляем один, в `nav.js` переключаем `data-p` динамически.

- [ ] **Step 2:** В `frontend/js/core/nav.js` добавить:
  ```js
  // role-aware Дашборд: specialist → отдельная страница
  // (предполагается, что в nav уже есть пункт data-p="dashboard")
  function applyDashboardRoleNav() {
    const me = JSON.parse(localStorage.getItem('lp_user') || '{}');
    if (me.role === 'specialist') {
      document.querySelectorAll('[data-p="dashboard"]').forEach(el => el.dataset.p = 'staff-dashboard');
    }
  }
  // вызвать после загрузки страницы (рядом с существующей applyRoleNav)
  applyDashboardRoleNav();
  ```
  Маршрут:
  ```js
  '#staff-dashboard': () => loadStaffDashboard(),
  ```
  (точная интеграция зависит от текущего nav-роутера — следовать паттерну остальных пунктов).

- [ ] **Step 3:** Создать `frontend/js/pages/staff-dashboard.js`:
  ```js
  // ── Personal Staff Dashboard ──────────────────────────────────
  'use strict';

  const _sdRoot = () => document.querySelector('#page-staff-dashboard .sd-root');
  const _sdState = { from: null, to: null, preset: 'week' };

  function _sdToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date()); }
  function _sdDaysAgo(n) {
    const d = new Date(_sdToday() + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - (n - 1));
    return d.toISOString().slice(0, 10);
  }
  function _sdSetPeriod(preset) {
    _sdState.preset = preset;
    _sdState.to = _sdToday();
    if (preset === 'today') _sdState.from = _sdState.to;
    else if (preset === 'week') _sdState.from = _sdDaysAgo(7);
    else if (preset === 'month') _sdState.from = _sdDaysAgo(30);
  }

  async function loadStaffDashboard() {
    document.querySelector('#page-staff-dashboard').hidden = false;
    if (!_sdState.from) _sdSetPeriod('week');
    await _sdRender();
  }

  async function _sdRender() {
    _sdRoot().innerHTML = `<div class="pp-hint">Загрузка…</div>`;
    let data;
    try {
      data = await api('GET', `/api/analytics/staff-dashboard?from=${_sdState.from}&to=${_sdState.to}`);
    } catch (e) {
      _sdRoot().innerHTML = `<div class="pp-hint" style="color:#c00">Ошибка: ${e.message}</div>`;
      return;
    }
    if (data.unlinked) {
      _sdRoot().innerHTML = `
        <div class="sc" style="text-align:center;padding:40px 20px">
          <h3 style="margin:0 0 10px">Профиль не привязан</h3>
          <p style="color:var(--t3)">Ваш логин не привязан к мастеру YClients.<br>
          Обратитесь к администратору клиники, чтобы посмотреть личную статистику.</p>
        </div>`;
      return;
    }
    const s = data.stats;
    const r = s.revenueByCategory;
    const fmtRub = (n) => parseFloat(n || 0).toLocaleString('ru');
    _sdRoot().innerHTML = `
      <div class="sd-toolbar" style="display:flex;gap:8px;padding:14px 0">
        ${['today','week','month'].map(p => `<button class="btn ${p===_sdState.preset?'btn-pri':''}" data-preset="${p}">${({today:'Сегодня',week:'Неделя',month:'Месяц'})[p]}</button>`).join('')}
        <span style="flex:1"></span>
        <span style="font-size:13px;color:var(--t3)">${_sdState.from} … ${_sdState.to}</span>
      </div>
      <div class="sg" style="grid-template-columns:repeat(3,1fr);gap:14px">
        <div class="sc">
          <div class="sl">Моя выручка за период</div>
          <div class="sv">₽ ${fmtRub(s.periodRevenue)}</div>
          <div class="sd" style="margin-top:8px;border-top:1px solid var(--bd);padding-top:8px">
            <div>Услуги: <b>₽ ${fmtRub(r.services)}</b></div>
            <div>Косметика: <b>₽ ${fmtRub(r.goods)}</b></div>
            <div>Абонементы: <b>₽ ${fmtRub(r.abonement)}</b></div>
          </div>
        </div>
        <div class="sc"><div class="sl">Визитов проведено</div><div class="sv">${s.periodRecords}</div></div>
        <div class="sc"><div class="sl">Уникальных клиентов</div><div class="sv">${s.uniqueClients}</div></div>
        <div class="sc"><div class="sl">Средний чек</div><div class="sv">₽ ${fmtRub(s.avgCheck)}</div></div>
        <div class="sc"><div class="sl">Первичных за период</div><div class="sv">${s.newClients}</div></div>
      </div>

      <div class="sc" style="margin-top:14px">
        <div class="sl">Дневной график выручки</div>
        <canvas id="sd-chart" width="800" height="160" style="width:100%;height:160px;display:block;margin-top:8px"></canvas>
      </div>

      <div class="sc" style="margin-top:14px">
        <div class="sl">Топ-5 услуг</div>
        ${data.topServices.length === 0 ? '<div class="pp-hint">Нет данных</div>' : `
          <table style="width:100%;margin-top:8px;font-size:13px">
            <thead><tr><th style="text-align:left;padding:6px 4px;color:var(--t3)">Услуга</th>
              <th style="text-align:right;padding:6px 4px;color:var(--t3)">Кол-во</th>
              <th style="text-align:right;padding:6px 4px;color:var(--t3)">Выручка</th></tr></thead>
            <tbody>
            ${data.topServices.map(t => `<tr>
              <td style="padding:6px 4px">${t.service_name}</td>
              <td style="text-align:right;padding:6px 4px">${t.cnt}</td>
              <td style="text-align:right;padding:6px 4px">₽ ${fmtRub(t.total_amount)}</td>
            </tr>`).join('')}
            </tbody></table>`}
      </div>
    `;

    _sdRoot().querySelectorAll('[data-preset]').forEach(b => {
      b.onclick = () => { _sdSetPeriod(b.dataset.preset); _sdRender(); };
    });

    // Простой бар-чарт через <canvas> (без внешних либ)
    const cv = _sdRoot().querySelector('#sd-chart');
    if (cv && data.dailyRevenue.length) _sdDrawChart(cv, data.dailyRevenue);
  }

  function _sdDrawChart(canvas, rows) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const max = Math.max(...rows.map(r => parseFloat(r.revenue)), 1);
    const barW = (w - 20) / rows.length;
    rows.forEach((r, i) => {
      const val = parseFloat(r.revenue);
      const barH = (val / max) * (h - 30);
      const x = 10 + i * barW;
      const y = h - 20 - barH;
      ctx.fillStyle = '#19c39c';
      ctx.fillRect(x + 2, y, Math.max(2, barW - 4), barH);
      ctx.fillStyle = '#888';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      if (rows.length <= 14 || i % Math.ceil(rows.length / 14) === 0) {
        ctx.fillText(r.d.slice(5), x + barW / 2, h - 5);   // MM-DD
      }
    });
  }
  ```

- [ ] **Step 4:** Локально открыть staff-dashboard в браузере как specialist (если есть тестовый пользователь). Если нет — создать через UI или напрямую: `INSERT INTO users(...) VALUES('test', ..., 'specialist', staff_member_id=...)`. Проверить:
  - Селектор периода переключает данные;
  - Карточки заполнены;
  - График рисуется;
  - Топ-5 услуг с цифрами.

- [ ] **Step 5:** Cache-bust в `index.html` (вершина — `?v=2026-06-01-staff`):
  ```html
  <link rel="stylesheet" href="css/base.css?v=2026-06-01-staff">
  ...
  <script src="js/pages/staff-dashboard.js?v=2026-06-01-staff"></script>
  ```

- [ ] **Step 6:** Commit:
  ```bash
  git add frontend/index.html frontend/js/core/nav.js frontend/js/pages/staff-dashboard.js frontend/css/base.css
  git commit -m "feat(ui): personal staff dashboard — search/period/cards/chart/top-5"
  ```

---

## Task 9: Smoke test

**Files:**
- Create: `backend/scripts/staff-dashboard-smoke.js`

- [ ] **Step 1:** Создать скрипт, который:
  1. Находит/создаёт specialist-юзера с заданным `staff_member_id`.
  2. Делает сессию (INSERT в `sessions`), минтит JWT.
  3. Дёргает `/api/analytics/staff-dashboard?from=...&to=...`.
  4. Проверяет форму ответа (все обязательные ключи).
  5. Дополнительно — кейс без привязки → ожидает `{unlinked:true}`.

  Шаблон по образцу `backend/scripts/patient-cases-smoke.js` (см. этот файл как референс).

- [ ] **Step 2:** Прогон локально:
  ```bash
  cd backend && SMOKE_TOKEN=... SMOKE_USER_ID=... node scripts/staff-dashboard-smoke.js
  ```
  Ожидается `✅ smoke ok`.

- [ ] **Step 3:** Commit:
  ```bash
  git add backend/scripts/staff-dashboard-smoke.js
  git commit -m "test: production smoke for /analytics/staff-dashboard"
  ```

---

## Task 10: Deploy

- [ ] **Step 1:** Push: `git push origin main`.

- [ ] **Step 2:** На прод-сервере:
  ```bash
  ssh root@217.114.0.254
  cd /root/loyalpro_new
  git pull origin main
  pm2 restart loyalpro
  pm2 logs loyalpro --lines 30  # убедиться, что миграции прошли и нет ошибок
  ```

- [ ] **Step 3:** Smoke на проде:
  ```bash
  cd /root/loyalpro_new/backend
  SMOKE_BASE=https://<prod-host> SMOKE_TOKEN=... SMOKE_USER_ID=... node scripts/staff-dashboard-smoke.js
  ```

- [ ] **Step 4:** Ручной чек-лист (через UI):
  - Зайти владельцем → «Дашборд» открывает клинический (без изменений).
  - Зайти под тестовым specialist без привязки → «Дашборд» показывает плашку «обратитесь к админу».
  - Зайти владельцем → «Пользователи» → отредактировать specialist → выбрать staff-сотрудника → сохранить.
  - Зайти под этим specialist → «Дашборд» показывает цифры, селектор периода работает, график рисуется, топ-5 заполнен.

---

## Definition of Done

- ✅ Все 10 задач выполнены, каждая атомарным коммитом.
- ✅ `npx jest` в `backend/` зелёный (unit-тесты pure helpers).
- ✅ Smoke-скрипт прошёл на dev и проде.
- ✅ Ручной чек-лист в браузере прошёл (3 роли: owner, specialist-linked, specialist-unlinked).
- ✅ `/api/analytics/dashboard` (клинический) НЕ изменился в поведении — старые скриншоты прежнего дашборда соответствуют.
- ✅ В `pm2 logs` нет ошибок при заходе specialist-юзеров.

## Откат при критике

```bash
ssh root@217.114.0.254
cd /root/loyalpro_new
git log --oneline -15
git revert <первый_коммит_фичи>..HEAD --no-commit && git commit -m "revert: personal staff dashboard"
pm2 restart loyalpro
```
Колонка `users.staff_member_id` остаётся в БД (пустой) — не мешает. Удалить руками если нужно:
```sql
ALTER TABLE users DROP COLUMN staff_member_id;
```
