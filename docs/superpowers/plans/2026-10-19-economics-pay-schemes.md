# Экономика: схемы оплаты труда — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить плоские правила оплаты (`staff_pay_rules`) схемами оплаты (линии: категории/услуги → процент, база, коэффициент ФОТ, фикс) с назначением схемы специалисту на период; приоритет линии — услуга > категория > «остальные услуги».

**Architecture:** Две новые таблицы (`pay_schemes` с линиями в JSONB, `pay_scheme_assignments`). Чистый `services/economics/pay-rules.js` переписывается: `resolvePay(pay, …)` ищет назначение сотрудника на дату визита, затем линию схемы по приоритету; `doctorPay` берёт множитель ФОТ из линии, иначе из настроек салона. `calc.js` получает `ctx.pay = {assignments, schemes}` вместо `ctx.payRules`. Роутер — CRUD схем и назначений с недоверчивой валидацией (конфликты линий, пересечения периодов, 409 на удаление назначенной схемы). Фронт — вкладка «Оплата труда» из трёх блоков (схемы с редактором линий и мультивыбором, назначения, сверка с YClients).

**Tech Stack:** Node.js/Express, `pg` без ORM, Jest (`npx jest economics`), фронт vanilla JS с `node --test frontend/js/pages/economics-table.test.js`.

**Спека:** `docs/superpowers/specs/2026-10-19-economics-pay-schemes-design.md`.

**Ветка:** работать в `feat/notifications-own-module` (там живёт экономика на деве). Модуль на проде отсутствует — контракт правил можно ломать.

**Раскладка по моделям** (правило из памяти: механика — Sonnet, связное ядро — Opus/Fable; Haiku не влезает в контекст):

| Задача | Модель | Почему |
|---|---|---|
| 1. Миграции + базовый снимок | Sonnet | две `CREATE TABLE IF NOT EXISTS` по образцу, один скрипт-замер |
| 2. Чистый `pay-rules.js` | Opus | ядро приоритетов и пересечений; от него зависят 3, 5, 6 |
| 3. `calc.js` + `report.js` | Opus | связная правка расчёта и тестов с денежными ожиданиями |
| 4. `store.js` | Sonnet | SQL и CRUD по образцу equipment |
| 5. Роутер | Opus | валидация схемы/назначений, 409/400, тесты без HTTP |
| 6. Чистые помощники фронта | Sonnet | зеркало серверной валидации, node-тесты |
| 7. UI вкладки | Opus | редактор линий с мультивыбором, три блока, CSS |
| 8. Документация + живая проверка на деве | Sonnet | CLAUDE.md, чек-лист приёмки, перезапуск, ввод схем |

Порядок строгий: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 (3 и 4 можно параллельно после 2; 6 — после 5).

---

## Карта файлов

- Modify: `backend/migrations.js` — таблицы `pay_schemes`, `pay_scheme_assignments` (рядом с `staff_pay_rules`, ~строка 2305).
- Rewrite: `backend/services/economics/pay-rules.js` — `resolvePay`, `pickAssignment`, `pickLineIdx`, `doctorPay`, `schemeLineConflicts`, `conflictText`, `assignmentsOverlap`, `isFallbackLine`.
- Rewrite: `backend/economics-pay-rules.test.js`.
- Modify: `backend/services/economics/calc.js:110-162` — `resolvePay` вместо `pickRule`, поля `pay_scheme_id`/`pay_line_idx`.
- Modify: `backend/economics-calc.test.js` — фикстура `ctx()` и тесты оплаты.
- Modify: `backend/services/economics/report.js:78,123` — `pay` в контексте, поля в `serviceDetail`.
- Modify: `backend/economics-report.test.js:22,95,100,162`.
- Modify: `backend/services/economics/store.js` — SQL и CRUD схем/назначений, `loadPeriod` → `pay`; удалить `PAY_RULES_SQL`/`listPayRules`/`insertPayRule`/`updatePayRule`/`deletePayRule`.
- Modify: `backend/economics-store.test.js:113,134`.
- Modify: `backend/scripts/economics-explain.js:57` — `d.pay.schemes.length` вместо `d.payRules.length`.
- Modify: `backend/routes/economics.js` — `parsePayScheme`, `parsePayAssignment`, ручки `/pay-schemes`, `/pay-assignments`; удалить `parsePayRule` и `/pay-rules`.
- Modify: `backend/economics-routes.test.js` — мок store, тесты парсеров и ручек.
- Modify: `frontend/js/pages/economics-table.js` — `ecoParseSchemeForm`, `ecoSchemeConflicts`, `ecoSchemeConflictText`, `ecoLineText`, `ecoLineIsFallback`, `ecoPlural`, `ecoParseAssignmentForm`, `ecoAssignmentsOverlap`, `ecoStaffWithoutScheme`; удалить `ecoParseRuleForm`, `ecoRuleScopeParts`.
- Modify: `frontend/js/pages/economics-table.test.js`.
- Modify: `frontend/js/pages/economics.js:304-375` — блок «Оплата труда».
- Modify: `frontend/css/features.css` (после строки 1249) — стили схем, линий, чипов.
- Modify: `frontend/index.html` — бамп `?v=` у `economics-table.js`, `economics.js`, `features.css`.
- Modify: `CLAUDE.md` (раздел «Экономика процедур»), `docs/2026-10-19-economics-acceptance.md` (п. 4).

Общие формы данных (используются во всех задачах):

```js
// Линия схемы (как в БД и в API-ответе):
{ percent: 15, base: 'gross' | 'net_of_materials', payroll_multiplier: null | 1.494, fixed_per_visit: 0, categories: [9536366], services: [15394061] }
// Схема (API-ответ): { id, title, note, lines: [...], assigned: [staff_yc_id…] }
// Назначение (БД/API): { id, staff_yc_id, scheme_id, valid_from: 'YYYY-MM-DD'|null, valid_to, note }
// Тело POST/PUT /pay-schemes:     { title, note, lines: [{ percent, base, payrollMultiplier, fixedPerVisit, categories, services }] }
// Тело POST/PUT /pay-assignments: { staffYcId, schemeId, validFrom, validTo, note }
// Контекст расчёта: ctx.pay = { assignments: [...], schemes: [...] }  (schemes — массив; resolvePay сам строит Map)
```

---

### Task 1: Миграции и базовый снимок оплаты на деве — **Sonnet**

**Files:**
- Modify: `backend/migrations.js` (после индекса `idx_staff_pay_rules_salon`, ~строка 2306)

- [ ] **Step 1: Снять базовый снимок оплаты врачей за сентябрь ДО правок** (чтобы в Task 8 сверить, что новая схема даёт те же суммы)

Run:
```bash
cd /root/loyalpro/backend && node -e "
const report=require('./services/economics/report'); const {db}=require('./db');
(async()=>{ const salon=await db.oneOrNone('SELECT * FROM salons WHERE id=1');
const r=await report.buildReport(salon,'2026-09-01','2026-09-30');
const by={}; for(const x of r.rows){ by[x.staff_yc_id]=Math.round(((by[x.staff_yc_id]||0)+x.doctor_pay)*100)/100; }
console.log(JSON.stringify(by)); process.exit(0); })().catch(e=>{console.error(e);process.exit(1);});" | tee /tmp/eco-pay-baseline-2026-09.json
```
Expected: JSON вида `{"5708379":NNNN.NN, "1910274":0, …}` — у 5708379 ненулевая сумма (два правила на деве), у остальных 0. Файл `/tmp/eco-pay-baseline-2026-09.json` нужен Task 8.

- [ ] **Step 2: Добавить таблицы в `migrations.js`** сразу после блока `idx_staff_pay_rules_salon`:

```js
  // Схемы оплаты труда (спека 2026-10-19-economics-pay-schemes-design.md): линии в JSONB
  // [{percent, base, payroll_multiplier|null, fixed_per_visit, categories:[], services:[]}].
  // staff_pay_rules остаётся (никогда деструктивно), кодом больше не читается.
  await client.query(`
    CREATE TABLE IF NOT EXISTS pay_schemes (
      id         SERIAL PRIMARY KEY,
      salon_id   INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      title      VARCHAR(120) NOT NULL,
      note       VARCHAR(500),
      lines      JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_pay_schemes_salon ON pay_schemes (salon_id)`).catch(() => {});
  // Назначение схемы специалисту на период; ON DELETE RESTRICT — удаление назначенной
  // схемы роутер отвергает (409), а не обнуляет оплату врача молча.
  await client.query(`
    CREATE TABLE IF NOT EXISTS pay_scheme_assignments (
      id          SERIAL PRIMARY KEY,
      salon_id    INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      staff_yc_id BIGINT NOT NULL,
      scheme_id   INT NOT NULL REFERENCES pay_schemes(id) ON DELETE RESTRICT,
      valid_from  DATE,
      valid_to    DATE,
      note        VARCHAR(500),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_pay_scheme_assignments_staff ON pay_scheme_assignments (salon_id, staff_yc_id)`).catch(() => {});
```

- [ ] **Step 3: Применить миграции на деве и проверить таблицы**

Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 5 && pm2 logs loyalpro --lines 20 --nostream | grep -i -E "migrat|error" | tail -5`
Затем через MCP `mcp__postgres__query`:
```sql
SELECT table_name, column_name, data_type FROM information_schema.columns
WHERE table_name IN ('pay_schemes','pay_scheme_assignments') ORDER BY table_name, ordinal_position
```
Expected: 7 колонок у `pay_schemes` (`lines` jsonb), 9 у `pay_scheme_assignments`.

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro && git add backend/migrations.js && git commit -m "feat(economics): таблицы pay_schemes и pay_scheme_assignments

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Чистый модуль `pay-rules.js` — **Opus**

**Files:**
- Rewrite: `backend/services/economics/pay-rules.js`
- Rewrite: `backend/economics-pay-rules.test.js`

- [ ] **Step 1: Переписать тест целиком**

```js
'use strict';
const P = require('./services/economics/pay-rules');

const L = (o) => ({ percent: 30, base: 'gross', payroll_multiplier: null, fixed_per_visit: 0, categories: [], services: [], ...o });
const A = (o) => ({ id: 1, staff_yc_id: 5, scheme_id: 1, valid_from: null, valid_to: null, ...o });
const pay = (schemes, assignments) => ({ schemes, assignments });
const q = (o) => ({ staffId: 5, serviceId: 10, categoryId: 100, date: '2026-09-15', ...o });

describe('resolvePay: назначение', () => {
  const scheme = { id: 1, lines: [L({})] };
  test('нет назначения / чужой сотрудник / нет схемы → null', () => {
    expect(P.resolvePay(pay([scheme], []), q())).toBeNull();
    expect(P.resolvePay(pay([scheme], [A({ staff_yc_id: 6 })]), q())).toBeNull();
    expect(P.resolvePay(pay([], [A({})]), q())).toBeNull();
    expect(P.resolvePay(null, q())).toBeNull();
  });
  test('период назначения: вне окна null, границы включительно, NULL = бесконечность', () => {
    const a = A({ valid_from: '2026-09-01', valid_to: '2026-09-30' });
    expect(P.resolvePay(pay([scheme], [a]), q({ date: '2026-08-31' }))).toBeNull();
    expect(P.resolvePay(pay([scheme], [a]), q({ date: '2026-09-01' })).schemeId).toBe(1);
    expect(P.resolvePay(pay([scheme], [a]), q({ date: '2026-09-30' })).schemeId).toBe(1);
    expect(P.resolvePay(pay([scheme], [a]), q({ date: '2026-10-01' }))).toBeNull();
    expect(P.resolvePay(pay([scheme], [A({ valid_from: '2026-09-01' })]), q({ date: '2099-01-01' })).schemeId).toBe(1);
  });
  test('два действующих назначения → позднейшее valid_from, затем больший id', () => {
    const s2 = { id: 2, lines: [L({ percent: 50 })] };
    const both = [A({ id: 1, scheme_id: 1, valid_from: '2026-01-01' }), A({ id: 2, scheme_id: 2, valid_from: '2026-06-01' })];
    expect(P.resolvePay(pay([scheme, s2], both), q()).schemeId).toBe(2);
    const tie = [A({ id: 1, scheme_id: 1 }), A({ id: 2, scheme_id: 2 })];
    expect(P.resolvePay(pay([scheme, s2], tie), q()).schemeId).toBe(2);
  });
  test('schemes принимает и Map', () => {
    expect(P.resolvePay({ schemes: new Map([[1, scheme]]), assignments: [A({})] }, q()).lineIdx).toBe(0);
  });
  test('id сравниваются как строки (bigint из pg приходит строкой)', () => {
    expect(P.resolvePay(pay([{ id: '1', lines: [L({ services: ['10'] })] }], [A({ staff_yc_id: '5', scheme_id: '1' })]), q()).lineIdx).toBe(0);
  });
});

describe('resolvePay: приоритет линий', () => {
  const scheme = { id: 1, lines: [
    L({ percent: 10 }),                                  // 0: остальные
    L({ percent: 15, categories: [100] }),               // 1: категория
    L({ percent: 20, services: [10], base: 'net_of_materials' }), // 2: услуга
  ] };
  const r = (o) => P.resolvePay(pay([scheme], [A({})]), q(o));
  test('услуга прямо > её категория > остальные', () => {
    expect(r()).toMatchObject({ schemeId: 1, lineIdx: 2, line: { percent: 20, base: 'net_of_materials' } });
    expect(r({ serviceId: 11 })).toMatchObject({ lineIdx: 1 });
    expect(r({ serviceId: 11, categoryId: 999 })).toMatchObject({ lineIdx: 0 });
    expect(r({ serviceId: 11, categoryId: null })).toMatchObject({ lineIdx: 0 });
  });
  test('без линии «остальные» непокрытая услуга → null', () => {
    const s = { id: 1, lines: [L({ categories: [100] })] };
    expect(P.resolvePay(pay([s], [A({})]), q({ categoryId: 999 }))).toBeNull();
  });
  test('схема без линий → null', () => {
    expect(P.resolvePay(pay([{ id: 1, lines: [] }], [A({})]), q())).toBeNull();
    expect(P.resolvePay(pay([{ id: 1 }], [A({})]), q())).toBeNull();
  });
});

describe('doctorPay', () => {
  const settings = { payroll_multiplier: 1.3, pay_base_includes_bonuses: false };
  const row = { price: 10000, revenue: 9000, materials_used: 1000 };
  test('gross: от выручки; множитель салона', () => {
    expect(P.doctorPay(row, L({ percent: 30 }), settings)).toEqual({ base: 9000, pay: 2700, cost: 3510, noRule: false });
  });
  test('множитель линии главнее салона; 0/отрицательный/мусор → салонный', () => {
    expect(P.doctorPay(row, L({ percent: 10, payroll_multiplier: 1.494 }), settings).cost).toBeCloseTo(1344.6, 6);
    expect(P.doctorPay(row, L({ percent: 10, payroll_multiplier: 0 }), settings).cost).toBe(1170);
    expect(P.doctorPay(row, L({ percent: 10, payroll_multiplier: 'x' }), settings).cost).toBe(1170);
  });
  test('net_of_materials: выручка − материалы; плюс фикс за визит', () => {
    expect(P.doctorPay(row, L({ percent: 40, base: 'net_of_materials', fixed_per_visit: 500 }), settings)).toEqual({ base: 8000, pay: 3700, cost: 4810, noRule: false });
  });
  test('pay_base_includes_bonuses → база price', () => {
    expect(P.doctorPay(row, L({ percent: 10 }), { ...settings, pay_base_includes_bonuses: true }).base).toBe(10000);
  });
  test('нет линии → 0 и noRule; отрицательная база → 0', () => {
    expect(P.doctorPay(row, null, settings)).toEqual({ base: 0, pay: 0, cost: 0, noRule: true });
    expect(P.doctorPay({ price: 100, revenue: 100, materials_used: 500 }, L({ percent: 50, base: 'net_of_materials' }), settings).pay).toBe(0);
  });
  test('битый множитель салона и пустой у линии → 1', () => {
    expect(P.doctorPay(row, L({ percent: 10 }), { payroll_multiplier: null }).cost).toBe(900);
  });
});

describe('schemeLineConflicts', () => {
  test('пусто — нет конфликтов; услуга в двух линиях; категория в двух линиях', () => {
    expect(P.schemeLineConflicts([L({ services: [1] }), L({ categories: [1] })])).toEqual([]);
    expect(P.schemeLineConflicts([L({ services: [1, 2] }), L({ services: [2] })])).toEqual([{ kind: 'service', id: 2, lines: [0, 1] }]);
    expect(P.schemeLineConflicts([L({ categories: [7] }), L({}), L({ categories: ['7'] })])).toEqual([{ kind: 'category', id: 7, lines: [0, 2] }]);
  });
  test('повтор id внутри ОДНОЙ линии — не конфликт', () => {
    expect(P.schemeLineConflicts([L({ services: [1, 1] })])).toEqual([]);
  });
  test('две линии без целей — конфликт fallback', () => {
    expect(P.schemeLineConflicts([L({}), L({ services: [1] }), L({})])).toEqual([{ kind: 'fallback', id: null, lines: [0, 2] }]);
  });
  test('conflictText — текст на русском с номерами линий (1-based)', () => {
    expect(P.conflictText({ kind: 'service', id: 2, lines: [0, 1] })).toBe('Услуга #2 стоит в линиях 1 и 2 — оставьте её в одной');
    expect(P.conflictText({ kind: 'category', id: 7, lines: [0, 2] })).toBe('Категория #7 стоит в линиях 1 и 3 — оставьте её в одной');
    expect(P.conflictText({ kind: 'fallback', id: null, lines: [0, 2] })).toBe('Линия «остальные услуги» может быть только одна (линии 1 и 3)');
  });
  test('isFallbackLine', () => {
    expect(P.isFallbackLine(L({}))).toBe(true);
    expect(P.isFallbackLine(L({ services: [1] }))).toBe(false);
    expect(P.isFallbackLine({})).toBe(true);
  });
});

describe('assignmentsOverlap', () => {
  const ex = [
    A({ id: 1, staff_yc_id: 5, valid_from: '2026-01-01', valid_to: '2026-06-30' }),
    A({ id: 2, staff_yc_id: 5, valid_from: '2026-07-01', valid_to: null }),
    A({ id: 3, staff_yc_id: 6, valid_from: null, valid_to: null }),
  ];
  test('пересечение по датам, открытые границы — бесконечность; чужой сотрудник не считается', () => {
    expect(P.assignmentsOverlap(ex, { staff_yc_id: 5, valid_from: '2026-06-30', valid_to: '2026-07-01' }).map(a => a.id)).toEqual([1, 2]);
    expect(P.assignmentsOverlap(ex, { staff_yc_id: 5, valid_from: '2025-01-01', valid_to: '2025-12-31' })).toEqual([]);
    expect(P.assignmentsOverlap(ex, { staff_yc_id: 5, valid_from: null, valid_to: null }).map(a => a.id)).toEqual([1, 2]);
    expect(P.assignmentsOverlap(ex, { staff_yc_id: 7, valid_from: null, valid_to: null })).toEqual([]);
  });
  test('редактируемая строка исключается по id', () => {
    expect(P.assignmentsOverlap(ex, { id: 2, staff_yc_id: 5, valid_from: '2026-07-01', valid_to: null })).toEqual([]);
    expect(P.assignmentsOverlap(ex, { id: '2', staff_yc_id: '5', valid_from: '2026-06-01', valid_to: null }).map(a => a.id)).toEqual([1]);
  });
});
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `cd /root/loyalpro/backend && npx jest economics-pay-rules 2>&1 | tail -15`
Expected: FAIL — `P.resolvePay is not a function` и т. п.

- [ ] **Step 3: Переписать `backend/services/economics/pay-rules.js` целиком**

```js
'use strict';
// Схемы оплаты врача (спека docs/superpowers/specs/2026-10-19-economics-pay-schemes-design.md, §3).
// Схема: { id, lines: [{ percent, base, payroll_multiplier|null, fixed_per_visit, categories:[], services:[] }] }.
// Назначение: { id, staff_yc_id, scheme_id, valid_from, valid_to } (строки 'YYYY-MM-DD', NULL = открыто).
// Приоритет линии: услуга названа прямо → её категория → линия без целей («остальные
// услуги») → null (нет оплаты, флаг no_pay_rule в calc). Чистый модуль, без БД.
function isNull(v) { return v === null || v === undefined; }
function day(v) { return v ? String(v).slice(0, 10) : null; }
function sameId(a, b) { return !isNull(a) && !isNull(b) && String(a) === String(b); }
function hasId(list, id) { return !isNull(id) && Array.isArray(list) && list.some(x => String(x) === String(id)); }
function isFallbackLine(line) { return !(line && Array.isArray(line.services) && line.services.length) && !(line && Array.isArray(line.categories) && line.categories.length); }

function activeOn(a, d) {
  return (!day(a.valid_from) || !d || day(a.valid_from) <= d) && (!day(a.valid_to) || !d || day(a.valid_to) >= d);
}

/** Назначение сотрудника, действующее на дату: позднейшее valid_from, затем больший id. */
function pickAssignment(assignments, staffId, date) {
  const d = day(date);
  const cands = (assignments || []).filter(a => a && sameId(a.staff_yc_id, staffId) && activeOn(a, d));
  if (!cands.length) return null;
  cands.sort((a, b) => String(day(b.valid_from) || '').localeCompare(String(day(a.valid_from) || '')) || Number(b.id || 0) - Number(a.id || 0));
  return cands[0];
}

/** Индекс линии схемы для услуги (услуга → категория → остальные) или -1. */
function pickLineIdx(lines, { serviceId, categoryId }) {
  const ls = Array.isArray(lines) ? lines : [];
  let i = ls.findIndex(l => l && hasId(l.services, serviceId)); if (i >= 0) return i;
  i = ls.findIndex(l => l && hasId(l.categories, categoryId)); if (i >= 0) return i;
  return ls.findIndex(l => l && isFallbackLine(l));
}

/** pay: { assignments: [...], schemes: Map(id→scheme) | [...] }. → { schemeId, lineIdx, line, assignmentId } | null */
function resolvePay(pay, { staffId, serviceId, categoryId, date }) {
  if (!pay) return null;
  const a = pickAssignment(pay.assignments, staffId, date);
  if (!a) return null;
  const schemes = pay.schemes instanceof Map ? pay.schemes : new Map((pay.schemes || []).map(s => [Number(s.id), s]));
  const scheme = schemes.get(Number(a.scheme_id));
  if (!scheme) return null;
  const lineIdx = pickLineIdx(scheme.lines, { serviceId, categoryId });
  if (lineIdx < 0) return null;
  return { schemeId: Number(scheme.id), lineIdx, line: scheme.lines[lineIdx], assignmentId: a.id };
}

/** row: {price, revenue, materials_used}; line — линия схемы (fixed_per_visit уже поделён calc'ом);
 *  settings: {payroll_multiplier, pay_base_includes_bonuses}. Множитель: линия > салон > 1. */
function doctorPay(row, line, settings = {}) {
  if (!line) return { base: 0, pay: 0, cost: 0, noRule: true };
  const own = Number(line.payroll_multiplier), salon = Number(settings.payroll_multiplier);
  const mult = own > 0 ? own : (salon > 0 ? salon : 1);
  const start = settings.pay_base_includes_bonuses ? Number(row.price) || 0 : Number(row.revenue) || 0;
  const base = line.base === 'net_of_materials' ? start - (Number(row.materials_used) || 0) : start;
  const pay = Math.max(0, base) * (Number(line.percent) || 0) / 100 + (Number(line.fixed_per_visit) || 0);
  return { base, pay, cost: pay * mult, noRule: false };
}

/** Конфликты линий схемы: [{kind:'service'|'category'|'fallback', id, lines:[i, j]}]. Пусто — схема корректна.
 *  Повтор id внутри одной линии конфликтом не считается (парсер дедупит). */
function schemeLineConflicts(lines) {
  const out = []; const seen = { service: new Map(), category: new Map() }; const fallbacks = [];
  (Array.isArray(lines) ? lines : []).forEach((l, i) => {
    if (!l) return;
    for (const [kind, key] of [['service', 'services'], ['category', 'categories']]) {
      for (const id of (Array.isArray(l[key]) ? l[key] : [])) {
        const k = String(id);
        const first = seen[kind].get(k);
        if (first === undefined) seen[kind].set(k, i);
        else if (first !== i && !out.some(c => c.kind === kind && String(c.id) === k)) out.push({ kind, id: Number(id), lines: [first, i] });
      }
    }
    if (isFallbackLine(l)) fallbacks.push(i);
  });
  if (fallbacks.length > 1) out.push({ kind: 'fallback', id: null, lines: fallbacks.slice(0, 2) });
  return out;
}

function conflictText(c) {
  const [a, b] = c.lines.map(i => i + 1);
  if (c.kind === 'fallback') return `Линия «остальные услуги» может быть только одна (линии ${a} и ${b})`;
  return `${c.kind === 'service' ? 'Услуга' : 'Категория'} #${c.id} стоит в линиях ${a} и ${b} — оставьте её в одной`;
}

/** Назначения того же сотрудника, чей период пересекается с кандидатом (NULL — бесконечность); cand.id исключается. */
function assignmentsOverlap(existing, cand) {
  const from = day(cand.valid_from) || '0000-00-00', to = day(cand.valid_to) || '9999-12-31';
  return (existing || []).filter(a => a && sameId(a.staff_yc_id, cand.staff_yc_id) && !(!isNull(cand.id) && sameId(a.id, cand.id)))
    .filter(a => (day(a.valid_from) || '0000-00-00') <= to && (day(a.valid_to) || '9999-12-31') >= from);
}

module.exports = { resolvePay, pickAssignment, pickLineIdx, doctorPay, schemeLineConflicts, conflictText, assignmentsOverlap, isFallbackLine };
```

- [ ] **Step 4: Запустить тесты модуля**

Run: `cd /root/loyalpro/backend && npx jest economics-pay-rules 2>&1 | tail -8`
Expected: PASS, все тесты зелёные. (`economics-calc` и другие сейчас красные — это ожидаемо до Task 3/4.)

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/economics/pay-rules.js backend/economics-pay-rules.test.js && git commit -m "feat(economics): pay-rules — resolvePay по схеме и назначению, конфликты линий, пересечения периодов

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `calc.js` и `report.js` на схемах — **Opus**

**Files:**
- Modify: `backend/services/economics/calc.js:7,110-162`
- Modify: `backend/economics-calc.test.js:20-27,118-153`
- Modify: `backend/services/economics/report.js:78,123`
- Modify: `backend/economics-report.test.js:22,95,100,162`

- [ ] **Step 1: Обновить фикстуру и тесты оплаты в `economics-calc.test.js`**

Заменить в `ctx()` (строка 26) поле `payRules: [...]` на:

```js
  pay: { assignments: [{ id: 1, staff_yc_id: 1910274, scheme_id: 1, valid_from: null, valid_to: null }],
    schemes: [{ id: 1, lines: [{ percent: 30, base: 'gross', payroll_multiplier: null, fixed_per_visit: 0, categories: [], services: [] }] }] },
```

Заменить блок тестов со строки `test('нет правила оплаты → 0 и no_pay_rule'` по конец теста `'fixed_per_visit у правила на конкретную услугу…'` (строки 118–153) на:

```js
  test('нет назначения → 0 и no_pay_rule; pay_scheme_id null', () => {
    const c = ctx(); c.pay = { assignments: [], schemes: c.pay.schemes };
    const rows = C.buildRows(RECORD, c);
    expect(rows[0].doctor_cost).toBe(0);
    expect(rows[0].no_pay_rule).toBe(true);
    expect(rows[0].pay_scheme_id).toBeNull(); expect(rows[0].pay_line_idx).toBeNull();
  });
  test('услуга вне линий схемы без «остальных» → no_pay_rule только у неё', () => {
    const c = ctx();
    c.pay.schemes = [{ id: 1, lines: [{ percent: 30, base: 'gross', payroll_multiplier: null, fixed_per_visit: 0, categories: [], services: [9536380] }] }];
    const rows = C.buildRows(RECORD, c);
    expect(rows[0].no_pay_rule).toBe(false); expect(rows[1].no_pay_rule).toBe(true);
  });
  test('база net_of_materials вычитает materials_used; pay_base_includes_bonuses → база price', () => {
    const c = ctx();
    c.pay.schemes = [{ id: 1, lines: [{ percent: 30, base: 'net_of_materials', payroll_multiplier: null, fixed_per_visit: 0, categories: [], services: [] }] }];
    let rows = C.buildRows(RECORD, c);
    expect(rows[0].pay_base).toBeCloseTo(22500 - 5387.63, 2);
    expect(rows[0].doctor_pay).toBeCloseTo((22500 - 5387.63) * 0.3, 2);
    c.settings.pay_base_includes_bonuses = true;
    rows = C.buildRows(RECORD, c);
    expect(rows[0].pay_base).toBeCloseTo(22500 - 5387.63, 2);
  });
  test('коэффициент ФОТ линии главнее настроек салона', () => {
    const c = ctx();
    c.pay.schemes = [{ id: 1, lines: [{ percent: 10, base: 'gross', payroll_multiplier: 1.494, fixed_per_visit: 0, categories: [], services: [] }] }];
    const rows = C.buildRows(RECORD, c);
    expect(rows[0].doctor_pay).toBeCloseTo(2250, 2);
    expect(rows[0].doctor_cost).toBeCloseTo(2250 * 1.494, 2);
  });
  test('fixed_per_visit — ОДИН раз на запись: у линии «остальные» делится между строками записи по цене', () => {
    const c = ctx();
    c.pay.schemes = [{ id: 1, lines: [{ percent: 0, base: 'gross', payroll_multiplier: null, fixed_per_visit: 500, categories: [], services: [] }] }];
    const rows = C.buildRows(RECORD, c);
    expect(rows[0].doctor_pay).toBeCloseTo(409.09, 2);
    expect(rows[1].doctor_pay).toBeCloseTo(90.91, 2);
    expect(rows[0].doctor_pay + rows[1].doctor_pay).toBeCloseTo(500, 6);
    expect(rows[0].doctor_cost).toBeCloseTo(409.09 * 1.3, 2);
  });
  test('fixed_per_visit у линии на конкретную услугу — целиком на её строку, другая строка по «остальным»', () => {
    const c = ctx();
    c.pay.schemes = [{ id: 1, lines: [
      { percent: 30, base: 'gross', payroll_multiplier: null, fixed_per_visit: 0, categories: [], services: [] },
      { percent: 10, base: 'gross', payroll_multiplier: null, fixed_per_visit: 300, categories: [], services: [25013124] },
    ] }];
    const rows = C.buildRows(RECORD, c);
    expect(rows[0].pay_scheme_id).toBe(1); expect(rows[0].pay_line_idx).toBe(0);
    expect(rows[0].doctor_pay).toBeCloseTo(22500 * 0.3, 2);
    expect(rows[1].pay_scheme_id).toBe(1); expect(rows[1].pay_line_idx).toBe(1);
    expect(rows[1].doctor_pay).toBeCloseTo(5000 * 0.1 + 300, 2);
  });
  test('приоритет: услуга в линии бьёт категорию той же услуги; категория бьёт «остальные»', () => {
    const c = ctx(); // category 100 у ботулинотерапии 25013124
    c.pay.schemes = [{ id: 1, lines: [
      { percent: 5, base: 'gross', payroll_multiplier: null, fixed_per_visit: 0, categories: [], services: [] },
      { percent: 15, base: 'gross', payroll_multiplier: null, fixed_per_visit: 0, categories: [100], services: [] },
      { percent: 20, base: 'gross', payroll_multiplier: null, fixed_per_visit: 0, categories: [], services: [25013124] },
    ] }];
    let rows = C.buildRows(RECORD, c);
    expect(rows[1].pay_line_idx).toBe(2); expect(rows[1].doctor_pay).toBeCloseTo(1000, 2);
    expect(rows[0].pay_line_idx).toBe(0); expect(rows[0].doctor_pay).toBeCloseTo(1125, 2);
    c.pay.schemes[0].lines.pop();
    rows = C.buildRows(RECORD, c);
    expect(rows[1].pay_line_idx).toBe(1); expect(rows[1].doctor_pay).toBeCloseTo(750, 2);
  });
  test('назначение, не действующее на дату визита → no_pay_rule', () => {
    const c = ctx(); c.pay.assignments = [{ id: 1, staff_yc_id: 1910274, scheme_id: 1, valid_from: '2026-11-01', valid_to: null }];
    expect(C.buildRows(RECORD, c)[0].no_pay_rule).toBe(true);
  });
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `cd /root/loyalpro/backend && npx jest economics-calc 2>&1 | tail -15`
Expected: FAIL (`pickRule`/`payRules` ещё в calc).

- [ ] **Step 3: Править `calc.js`**

Строка 7: `const { pickRule, doctorPay } = require('./pay-rules');` → `const { resolvePay, doctorPay } = require('./pay-rules');`

В шапке-комментарии (строки ~20–21) заменить `payRules:[…]` на `pay:{assignments, schemes}`.

Блок строк 112–127 (от комментария «Правило оплаты (§3.3)…» до конца цикла `for (const idx of byRule.values())`) заменить на:

```js
  // Линия схемы оплаты выбирается на каждую строку (спека 2026-10-19, §3); fixed_per_visit —
  // «за визит», поэтому у линии, под которую попало несколько строк ОДНОЙ записи, фикс
  // берётся один раз и делится между ними по цене (иначе линия «остальные услуги» с
  // фиксом начисляла бы его на каждую услугу записи).
  const hits = services.map(s => {
    const categoryId = categories.has(String(s.id)) ? categories.get(String(s.id)) : null;
    return { categoryId, hit: resolvePay(ctx && ctx.pay, { staffId, serviceId: s.id, categoryId, date }) };
  });
  const fixedShare = services.map(() => 0);
  const byLine = new Map();
  hits.forEach((h, i) => { if (h.hit) { const k = `${h.hit.schemeId}:${h.hit.lineIdx}`; if (!byLine.has(k)) byLine.set(k, []); byLine.get(k).push(i); } });
  for (const idx of byLine.values()) {
    const fixed = n(hits[idx[0]].hit.line.fixed_per_visit);
    if (idx.length === 1 || !fixed) { idx.forEach(i => { fixedShare[i] = fixed; }); continue; }
    const parts = splitByWeights(fixed, idx.map(i => prices[i]));
    idx.forEach((i, k) => { fixedShare[i] = parts[k]; });
  }
```

Внутри `return services.map((s, i) => {…})`:
- `const { categoryId, rule } = rules[i];` → `const { categoryId, hit } = hits[i];`
- строка с `doctorPay(...)` → `const dp = doctorPay({ price: s.price + bonusApplied, revenue, materials_used }, hit ? { ...hit.line, fixed_per_visit: fixedShare[i] } : null, settings);`
- поле `pay_rule_id: rule ? rule.id : null,` → `pay_scheme_id: hit ? hit.schemeId : null, pay_line_idx: hit ? hit.lineIdx : null,`

- [ ] **Step 4: Запустить тесты calc**

Run: `cd /root/loyalpro/backend && npx jest economics-calc 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 5: `report.js`** — строка 78: `payRules: data.payRules` → `pay: data.pay`; строка 123 в `serviceDetail`: после `no_pay_rule: x.no_pay_rule,` добавить `pay_scheme_id: x.pay_scheme_id, pay_line_idx: x.pay_line_idx,`.

- [ ] **Step 6: `economics-report.test.js`** — строка 22: заменить `payRules: [...]` на
```js
    pay: { assignments: [{ id: 1, staff_yc_id: 5, scheme_id: 1, valid_from: null, valid_to: null }],
      schemes: [{ id: 1, lines: [{ percent: 10, base: 'gross', payroll_multiplier: null, fixed_per_visit: 0, categories: [], services: [] }] }] },
```
(если `staff_yc_id` записей в фикстуре `period()` другой — взять его; проверить `grep -n staff_yc_id backend/economics-report.test.js | head -3`).
Строка 95: `p.payRules = [...]` → `p.pay.schemes = [{ id: 7, lines: [{ percent: 50, base: 'gross', payroll_multiplier: null, fixed_per_visit: 0, categories: [200], services: [] }] }]; p.pay.assignments = [{ id: 1, staff_yc_id: <staff из фикстуры>, scheme_id: 7, valid_from: null, valid_to: null }];`
Строка 100: `expect(r.rows[0].pay_rule_id).toBe(7);` → `expect(r.rows[0].pay_scheme_id).toBe(7); expect(r.rows[0].pay_line_idx).toBe(0);`
Строка 162: `p.payRules = [...]` → `p.pay.schemes = [{ id: 1, lines: [{ percent: 0, base: 'gross', payroll_multiplier: null, fixed_per_visit: 300, categories: [], services: [] }] }];`

- [ ] **Step 7: Запустить тесты report и calc**

Run: `cd /root/loyalpro/backend && npx jest economics-calc economics-report 2>&1 | tail -8`
Expected: PASS оба набора (`economics-report` мокает store — `loadPeriod` отдаёт фикстуру, Task 4 его не блокирует).

- [ ] **Step 8: Commit**

```bash
cd /root/loyalpro && git add backend/services/economics/calc.js backend/services/economics/report.js backend/economics-calc.test.js backend/economics-report.test.js && git commit -m "feat(economics): расчёт оплаты врача по схемам (ctx.pay, pay_scheme_id/pay_line_idx)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `store.js` — SQL и CRUD схем и назначений — **Sonnet**

**Files:**
- Modify: `backend/services/economics/store.js` (константы ~256–259, `loadPeriod` ~306–335, CRUD ~426–436, exports ~500–506)
- Modify: `backend/economics-store.test.js:113,134`
- Modify: `backend/scripts/economics-explain.js:57`

- [ ] **Step 1: Обновить тест `loadPeriod`** — строка 113 (мок `FROM staff_pay_rules`) заменить на две:

```js
      if (/FROM pay_schemes/.test(sql)) return [{ id: 1, title: 'Базовая', note: null, lines: [{ percent: 30, base: 'gross', payroll_multiplier: null, fixed_per_visit: 0, categories: [], services: [] }] }];
      if (/FROM pay_scheme_assignments/.test(sql)) return [{ id: 1, staff_yc_id: '5', scheme_id: 1, valid_from: null, valid_to: null, note: null }];
```
Строку 134 `expect(d.payRules[0].percent).toBe(30);` заменить на:
```js
    expect(d.pay.schemes[0].lines[0].percent).toBe(30);
    expect(d.pay.assignments[0]).toEqual({ id: 1, staff_yc_id: 5, scheme_id: 1, valid_from: null, valid_to: null, note: null });
```
И добавить в конец файла новый блок:

```js
describe('схемы оплаты: CRUD', () => {
  beforeEach(() => jest.clearAllMocks());
  test('insertPaySchemes пишет lines как jsonb и возвращает id', async () => {
    db.one.mockResolvedValue({ id: 12 });
    const lines = [{ percent: 15, base: 'gross', payroll_multiplier: null, fixed_per_visit: 0, categories: [1], services: [] }];
    const id = await store.insertPayScheme(1, { title: 'Инъекции', note: '', lines });
    expect(id).toBe(12);
    const [sql, params] = db.one.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO pay_schemes/); expect(sql).toMatch(/::jsonb/);
    expect(params).toEqual([1, 'Инъекции', '', JSON.stringify(lines)]);
  });
  test('deletePayScheme: назначена → "assigned" без DELETE; нет строки → "missing"; удалена → "deleted"', async () => {
    db.oneOrNone.mockResolvedValueOnce({ n: '2' });
    expect(await store.deletePayScheme(1, 5)).toBe('assigned');
    expect(db.query).not.toHaveBeenCalled();
    db.oneOrNone.mockResolvedValueOnce({ n: '0' }); db.query.mockResolvedValueOnce({ rowCount: 0 });
    expect(await store.deletePayScheme(1, 5)).toBe('missing');
    db.oneOrNone.mockResolvedValueOnce({ n: '0' }); db.query.mockResolvedValueOnce({ rowCount: 1 });
    expect(await store.deletePayScheme(1, 5)).toBe('deleted');
    expect(db.query.mock.calls[1][1]).toEqual([1, 5]);
  });
  test('paySchemeExists и назначения ограничены salon_id', async () => {
    db.oneOrNone.mockResolvedValue({ id: 3 });
    expect(await store.paySchemeExists(1, 3)).toBe(true);
    expect(db.oneOrNone.mock.calls[0][1]).toEqual([1, 3]);
    db.one.mockResolvedValue({ id: 9 });
    const id = await store.insertPayAssignment(1, { staff_yc_id: 5, scheme_id: 3, valid_from: '2026-02-01', valid_to: null, note: '' });
    expect(id).toBe(9);
    expect(db.one.mock.calls[0][1]).toEqual([1, 5, 3, '2026-02-01', null, '']);
    db.query.mockResolvedValue({ rowCount: 1 });
    expect(await store.deletePayAssignment(1, 9)).toBe(true);
    expect(db.query.mock.calls[0][1]).toEqual([1, 9]);
  });
});
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `cd /root/loyalpro/backend && npx jest economics-store 2>&1 | tail -12`
Expected: FAIL (`store.insertPayScheme is not a function`, `d.pay` undefined). Если мок `./db` в шапке этого теста не содержит `one` или `query` — добавить их в `jest.mock('./db', …)` там же (новые тесты зовут `db.one`, `db.oneOrNone`, `db.query`).

- [ ] **Step 3: Править `store.js`**

Заменить константу `PAY_RULES_SQL` (строки 256–259) на:

```js
const PAY_SCHEMES_SQL = `SELECT id, title, note, lines FROM pay_schemes WHERE salon_id = $1 ORDER BY title, id`;
const PAY_ASSIGNMENTS_SQL = `
  SELECT id, staff_yc_id, scheme_id, to_char(valid_from, 'YYYY-MM-DD') AS valid_from, to_char(valid_to, 'YYYY-MM-DD') AS valid_to, note
  FROM pay_scheme_assignments WHERE salon_id = $1 ORDER BY staff_yc_id, valid_from NULLS FIRST, id`;
function normScheme(r) { return { id: Number(r.id), title: r.title || '', note: r.note, lines: Array.isArray(r.lines) ? r.lines : [] }; }
function normAssignment(r) { return { id: Number(r.id), staff_yc_id: toInt(r.staff_yc_id), scheme_id: Number(r.scheme_id), valid_from: r.valid_from || null, valid_to: r.valid_to || null, note: r.note === undefined ? null : r.note }; }
```

В `loadPeriod`: в деструктуризации `const [cardRows, linkRows, payRuleRows, …]` заменить `payRuleRows` на `schemeRows, assignmentRows` и в `Promise.all` вместо `db.any(PAY_RULES_SQL, [salonId])` поставить `db.any(PAY_SCHEMES_SQL, [salonId]), db.any(PAY_ASSIGNMENTS_SQL, [salonId])` (порядок в массиве и в деструктуризации должен совпасть). В возвращаемом объекте строку `payRules: payRuleRows.map(...)` заменить на:

```js
    pay: { schemes: schemeRows.map(normScheme), assignments: assignmentRows.map(normAssignment) },
```

Заменить функции `listPayRules`…`deletePayRule` (строки 426–436) на:

```js
async function listPaySchemes(salonId) { return (await db.any(PAY_SCHEMES_SQL, [salonId])).map(normScheme); }
async function listPayAssignments(salonId) { return (await db.any(PAY_ASSIGNMENTS_SQL, [salonId])).map(normAssignment); }
async function paySchemeExists(salonId, id) { return !!(await db.oneOrNone('SELECT id FROM pay_schemes WHERE salon_id=$1 AND id=$2', [salonId, id])); }
async function insertPayScheme(salonId, v) {
  const r = await db.one(`INSERT INTO pay_schemes (salon_id, title, note, lines) VALUES ($1,$2,$3,$4::jsonb) RETURNING id`, [salonId, v.title, v.note, JSON.stringify(v.lines)]);
  return r ? Number(r.id) : null;
}
async function updatePayScheme(salonId, id, v) {
  const r = await db.query(`UPDATE pay_schemes SET title=$3, note=$4, lines=$5::jsonb, updated_at=NOW() WHERE salon_id=$1 AND id=$2`, [salonId, id, v.title, v.note, JSON.stringify(v.lines)]);
  return r.rowCount > 0;
}
/** 'assigned' — есть назначения (не удаляем), 'missing' — нет такой схемы, 'deleted'. */
async function deletePayScheme(salonId, id) {
  const c = await db.oneOrNone('SELECT count(*)::int AS n FROM pay_scheme_assignments WHERE salon_id=$1 AND scheme_id=$2', [salonId, id]);
  if (c && Number(c.n) > 0) return 'assigned';
  const r = await db.query('DELETE FROM pay_schemes WHERE salon_id=$1 AND id=$2', [salonId, id]);
  return r.rowCount > 0 ? 'deleted' : 'missing';
}
async function insertPayAssignment(salonId, v) {
  const r = await db.one(`INSERT INTO pay_scheme_assignments (salon_id, staff_yc_id, scheme_id, valid_from, valid_to, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [salonId, v.staff_yc_id, v.scheme_id, v.valid_from, v.valid_to, v.note]);
  return r ? Number(r.id) : null;
}
async function updatePayAssignment(salonId, id, v) {
  const r = await db.query(`UPDATE pay_scheme_assignments SET staff_yc_id=$3, scheme_id=$4, valid_from=$5, valid_to=$6, note=$7, updated_at=NOW() WHERE salon_id=$1 AND id=$2`,
    [salonId, id, v.staff_yc_id, v.scheme_id, v.valid_from, v.valid_to, v.note]);
  return r.rowCount > 0;
}
async function deletePayAssignment(salonId, id) { const r = await db.query('DELETE FROM pay_scheme_assignments WHERE salon_id=$1 AND id=$2', [salonId, id]); return r.rowCount > 0; }
```

В `module.exports`: убрать `PAY_RULES_SQL, listPayRules, insertPayRule, updatePayRule, deletePayRule`, добавить `PAY_SCHEMES_SQL, PAY_ASSIGNMENTS_SQL, listPaySchemes, listPayAssignments, paySchemeExists, insertPayScheme, updatePayScheme, deletePayScheme, insertPayAssignment, updatePayAssignment, deletePayAssignment`.

- [ ] **Step 4: `scripts/economics-explain.js:57`** — `${d.payRules.length} правил` → `${d.pay.schemes.length} схем, ${d.pay.assignments.length} назначений`.

- [ ] **Step 5: Запустить тесты store + весь economics (роутер пока красный — это Task 5)**

Run: `cd /root/loyalpro/backend && npx jest economics-store 2>&1 | tail -8 && grep -rn "payRules\|PAY_RULES_SQL\|listPayRules" services/economics scripts | grep -v node_modules`
Expected: PASS; grep пустой.

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add backend/services/economics/store.js backend/economics-store.test.js backend/scripts/economics-explain.js && git commit -m "feat(economics): store — схемы оплаты и назначения, loadPeriod отдаёт pay

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Роутер — парсеры и ручки схем/назначений — **Opus**

**Files:**
- Modify: `backend/routes/economics.js` (парсер ~43–57, ручки ~260–280, exports ~371–381)
- Modify: `backend/economics-routes.test.js` (мок store ~12–20, импорт 28, describe `parsePayRule` 43–60, ручки 97–143)

- [ ] **Step 1: Обновить тесты**

В `jest.mock('./services/economics/store', …)` заменить `listPayRules: jest.fn(), insertPayRule: jest.fn(), updatePayRule: jest.fn(), deletePayRule: jest.fn(),` на:
```js
  listPaySchemes: jest.fn(), listPayAssignments: jest.fn(), paySchemeExists: jest.fn(), insertPayScheme: jest.fn(), updatePayScheme: jest.fn(), deletePayScheme: jest.fn(),
  insertPayAssignment: jest.fn(), updatePayAssignment: jest.fn(), deletePayAssignment: jest.fn(),
```
Строка 28: `parsePayRule` → `parsePayScheme, parsePayAssignment`.

Заменить `describe('parsePayRule', …)` (строки 43–60) на:

```js
describe('parsePayScheme', () => {
  const line = { percent: 15, base: 'gross', payrollMultiplier: null, fixedPerVisit: 0, categories: [100, 101], services: [] };
  const ok = { title: ' Инъекции ', note: 'n', lines: [line, { ...line, categories: [], services: [10, '11', 10], base: 'net_of_materials', payrollMultiplier: '1.494', fixedPerVisit: '' }] };
  test('валидное тело: trim названия, дедуп id, числа из строк, пустой мульт → null', () => {
    expect(parsePayScheme(ok).value).toEqual({ title: 'Инъекции', note: 'n', lines: [
      { percent: 15, base: 'gross', payroll_multiplier: null, fixed_per_visit: 0, categories: [100, 101], services: [] },
      { percent: 15, base: 'net_of_materials', payroll_multiplier: 1.494, fixed_per_visit: 0, categories: [], services: [10, 11] },
    ] });
  });
  test('ошибки', () => {
    expect(parsePayScheme({ ...ok, title: '' }).error).toMatch(/назван/i);
    expect(parsePayScheme({ ...ok, title: 'x'.repeat(121) }).error).toMatch(/назван/i);
    expect(parsePayScheme({ ...ok, lines: [] }).error).toMatch(/лини/i);
    expect(parsePayScheme({ ...ok, lines: 'x' }).error).toMatch(/лини/i);
    expect(parsePayScheme({ ...ok, lines: Array.from({ length: 51 }, () => line) }).error).toMatch(/1–50/);
    expect(parsePayScheme({ ...ok, lines: [{ ...line, percent: 101 }] }).error).toMatch(/Линия 1: процент/);
    expect(parsePayScheme({ ...ok, lines: [{ ...line, percent: '' }] }).error).toMatch(/процент/);
    expect(parsePayScheme({ ...ok, lines: [{ ...line, base: 'net' }] }).error).toMatch(/база/i);
    expect(parsePayScheme({ ...ok, lines: [{ ...line, payrollMultiplier: 0.9 }] }).error).toMatch(/ФОТ/);
    expect(parsePayScheme({ ...ok, lines: [{ ...line, payrollMultiplier: 'x' }] }).error).toMatch(/ФОТ/);
    expect(parsePayScheme({ ...ok, lines: [{ ...line, fixedPerVisit: -1 }] }).error).toMatch(/фикс/i);
    expect(parsePayScheme({ ...ok, lines: [{ ...line, categories: 'x' }] }).error).toMatch(/категории — список/i);
    expect(parsePayScheme({ ...ok, lines: [{ ...line, services: [0] }] }).error).toMatch(/услуги/i);
    expect(parsePayScheme({ ...ok, lines: [line, { ...line, categories: [101] }] }).error).toMatch(/Категория #101 стоит в линиях 1 и 2/);
    expect(parsePayScheme({ ...ok, lines: [{ ...line, categories: [], services: [5] }, { ...line, categories: [], services: [5] }] }).error).toMatch(/Услуга #5/);
    expect(parsePayScheme({ ...ok, lines: [{ ...line, categories: [] }, { ...line, categories: [] }] }).error).toMatch(/остальные услуги/);
  });
  test('услуга в одной линии и её категория в другой — законно; заметка режется до 500', () => {
    const r = parsePayScheme({ title: 't', note: 'я'.repeat(600), lines: [{ ...line, categories: [100] }, { ...line, categories: [], services: [7] }] });
    expect(r.error).toBeUndefined();
    expect(r.value.note).toHaveLength(500);
  });
});

describe('parsePayAssignment', () => {
  const ok = { staffYcId: 5, schemeId: 3, validFrom: '2026-02-01', validTo: null, note: '' };
  test('валидное тело', () => {
    expect(parsePayAssignment(ok).value).toEqual({ staff_yc_id: 5, scheme_id: 3, valid_from: '2026-02-01', valid_to: null, note: '' });
    expect(parsePayAssignment({ staffYcId: '5', schemeId: '3' }).value).toEqual({ staff_yc_id: 5, scheme_id: 3, valid_from: null, valid_to: null, note: '' });
  });
  test('ошибки', () => {
    expect(parsePayAssignment({ ...ok, staffYcId: null }).error).toMatch(/сотрудник/i);
    expect(parsePayAssignment({ ...ok, staffYcId: 'abc' }).error).toMatch(/сотрудник/i);
    expect(parsePayAssignment({ ...ok, schemeId: 0 }).error).toMatch(/схем/i);
    expect(parsePayAssignment({ ...ok, validFrom: '2026-02-30' }).error).toMatch(/дат/i);
    expect(parsePayAssignment({ ...ok, validFrom: '2026-05-01', validTo: '2026-04-01' }).error).toMatch(/период/i);
  });
});
```

В `describe('роутер без HTTP')` заменить тесты про `/pay-rules` (от `'не-owner (admin) получает 403…'` до `'нечисловой :id не попадает…'` включительно) на:

```js
  test('не-owner (admin) получает 403 на любой ручке, store не вызывается', async () => {
    const r = await call('GET', '/pay-schemes', { user: { role: 'admin', salonId: 1 } });
    expect(r.status).toBe(403);
    expect(store.listPaySchemes).not.toHaveBeenCalled();
  });

  test('GET /pay-schemes: схемы с assigned и назначения, всё по salonId из токена', async () => {
    store.listPaySchemes.mockResolvedValue([{ id: 1, title: 'A', note: null, lines: [] }, { id: 2, title: 'B', note: null, lines: [] }]);
    store.listPayAssignments.mockResolvedValue([{ id: 7, staff_yc_id: 5, scheme_id: 1 }, { id: 8, staff_yc_id: 6, scheme_id: 1 }, { id: 9, staff_yc_id: 5, scheme_id: 1 }]);
    const r = await call('GET', '/pay-schemes');
    expect(r.status).toBe(200);
    expect(store.listPaySchemes).toHaveBeenCalledWith(1);
    expect(r.body.schemes.map(s => s.assigned)).toEqual([[5, 6], []]);
    expect(r.body.assignments).toHaveLength(3);
  });

  test('PUT /settings с мусором — 400, ничего не пишется и кэш не сбрасывается', async () => {
    const r = await call('PUT', '/settings', { body: { payrollMultiplier: 9, allocationDriver: 'minutes' } });
    expect(r.status).toBe(400);
    expect(store.saveSettings).not.toHaveBeenCalled();
    expect(report.invalidate).not.toHaveBeenCalled();
  });

  test('PUT /settings валидный — пишет и сбрасывает кэш отчёта', async () => {
    store.saveSettings.mockResolvedValue();
    const r = await call('PUT', '/settings', { body: { payrollMultiplier: 1.3, allocationDriver: 'minutes' } });
    expect(r.status).toBe(200);
    expect(store.saveSettings).toHaveBeenCalledWith(1, expect.objectContaining({ payroll_multiplier: 1.3 }));
    expect(report.invalidate).toHaveBeenCalledWith(1);
  });

  test('POST /pay-schemes создаёт и сбрасывает кэш; мусор — 400 без записи', async () => {
    store.insertPayScheme.mockResolvedValue(7);
    const body = { title: 'A', lines: [{ percent: 30, base: 'gross', categories: [1] }] };
    const r = await call('POST', '/pay-schemes', { body });
    expect(r).toEqual({ status: 200, body: { id: 7 } });
    expect(store.insertPayScheme).toHaveBeenCalledWith(1, expect.objectContaining({ title: 'A' }));
    expect(report.invalidate).toHaveBeenCalledWith(1);
    report.invalidate.mockClear();
    expect((await call('POST', '/pay-schemes', { body: { title: 'A', lines: [] } })).status).toBe(400);
    expect(report.invalidate).not.toHaveBeenCalled();
  });

  test('DELETE /pay-schemes: назначена → 409, нет → 404, удалена → 200 + сброс кэша', async () => {
    store.deletePayScheme.mockResolvedValueOnce('assigned');
    const a = await call('DELETE', '/pay-schemes/5');
    expect(a.status).toBe(409); expect(a.body.error).toMatch(/назначен/i);
    store.deletePayScheme.mockResolvedValueOnce('missing');
    expect((await call('DELETE', '/pay-schemes/5')).status).toBe(404);
    expect(report.invalidate).not.toHaveBeenCalled();
    store.deletePayScheme.mockResolvedValueOnce('deleted');
    expect((await call('DELETE', '/pay-schemes/5')).status).toBe(200);
    expect(store.deletePayScheme).toHaveBeenCalledWith(1, 5);
    expect(report.invalidate).toHaveBeenCalledWith(1);
  });

  test('POST /pay-assignments: чужая схема — 400; пересечение периода — 400 с номером; иначе insert', async () => {
    const body = { staffYcId: 5, schemeId: 3, validFrom: '2026-06-01', validTo: null };
    store.paySchemeExists.mockResolvedValue(false);
    expect((await call('POST', '/pay-assignments', { body })).status).toBe(400);
    expect(store.insertPayAssignment).not.toHaveBeenCalled();
    store.paySchemeExists.mockResolvedValue(true);
    store.listPayAssignments.mockResolvedValue([{ id: 11, staff_yc_id: 5, scheme_id: 2, valid_from: '2026-01-01', valid_to: '2026-06-30' }]);
    const clash = await call('POST', '/pay-assignments', { body });
    expect(clash.status).toBe(400); expect(clash.body.error).toMatch(/пересека/i);
    expect(store.insertPayAssignment).not.toHaveBeenCalled();
    store.listPayAssignments.mockResolvedValue([{ id: 11, staff_yc_id: 5, scheme_id: 2, valid_from: '2026-01-01', valid_to: '2026-05-31' }]);
    store.insertPayAssignment.mockResolvedValue(12);
    const ok = await call('POST', '/pay-assignments', { body });
    expect(ok).toEqual({ status: 200, body: { id: 12 } });
    expect(store.insertPayAssignment).toHaveBeenCalledWith(1, { staff_yc_id: 5, scheme_id: 3, valid_from: '2026-06-01', valid_to: null, note: '' });
    expect(report.invalidate).toHaveBeenCalledWith(1);
  });

  test('PUT /pay-assignments/:id исключает саму строку из проверки пересечения; чужой id — 404', async () => {
    store.paySchemeExists.mockResolvedValue(true);
    store.listPayAssignments.mockResolvedValue([{ id: 11, staff_yc_id: 5, scheme_id: 2, valid_from: '2026-01-01', valid_to: null }]);
    store.updatePayAssignment.mockResolvedValue(true);
    const r = await call('PUT', '/pay-assignments/11', { body: { staffYcId: 5, schemeId: 2, validFrom: '2026-02-01' } });
    expect(r.status).toBe(200);
    expect(store.updatePayAssignment).toHaveBeenCalledWith(1, 11, expect.objectContaining({ valid_from: '2026-02-01' }));
    store.updatePayAssignment.mockResolvedValue(false);
    store.listPayAssignments.mockResolvedValue([]); // иначе бессрочный кандидат пересёкся бы со строкой 11 и дал 400 раньше 404
    expect((await call('PUT', '/pay-assignments/99', { body: { staffYcId: 5, schemeId: 2 } })).status).toBe(404);
  });

  test('нечисловой :id не попадает в обработчик (404)', async () => {
    const r = await call('DELETE', '/pay-schemes/abc');
    expect(r.status).toBe(404);
    expect(store.deletePayScheme).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `cd /root/loyalpro/backend && npx jest economics-routes 2>&1 | tail -12`
Expected: FAIL (`parsePayScheme is not a function`).

- [ ] **Step 3: Править `routes/economics.js`**

Добавить импорт после строки `const { buildDictionaries } = …`:
```js
const { schemeLineConflicts, conflictText, assignmentsOverlap } = require('../services/economics/pay-rules');
```
Добавить константу рядом с `PAY_BASES`: `const MAX_SCHEME_LINES = 50;`

Заменить `function parsePayRule(b) {…}` (строки 43–57) на:

```js
function parseIdList(v, label) {
  if (v === undefined || v === null) return { value: [] };
  if (!Array.isArray(v)) return { error: `${label} — список` };
  const ids = v.map(optInt);
  if (ids.some(x => !x)) return { error: `${label} — целые положительные id` };
  return { value: [...new Set(ids)] };
}
// Схема оплаты (спека 2026-10-19-economics-pay-schemes-design.md §2): линии с процентом,
// базой, коэффициентом ФОТ (null = из настроек салона), фиксом и целями.
function parsePayScheme(b) {
  b = b || {};
  const title = String(b.title || '').trim();
  if (!title || title.length > 120) return { error: 'Название схемы — 1–120 символов' };
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > MAX_SCHEME_LINES) return { error: `Линии — список из 1–${MAX_SCHEME_LINES}` };
  const lines = [];
  for (const [i, l] of b.lines.entries()) {
    const n = i + 1;
    if (!l || typeof l !== 'object' || Array.isArray(l)) return { error: `Линия ${n}: объект` };
    const percent = typeof l.percent === 'number' || typeof l.percent === 'string' ? Number(l.percent) : NaN;
    if (l.percent === '' || !Number.isFinite(percent) || percent < 0 || percent > 100) return { error: `Линия ${n}: процент 0–100` };
    if (!PAY_BASES.includes(l.base)) return { error: `Линия ${n}: база gross или net_of_materials` };
    let mult = null;
    if (!(l.payrollMultiplier === undefined || l.payrollMultiplier === null || l.payrollMultiplier === '')) {
      mult = (typeof l.payrollMultiplier === 'number' || typeof l.payrollMultiplier === 'string') ? Number(l.payrollMultiplier) : NaN;
      if (!Number.isFinite(mult) || mult < 1 || mult > 3) return { error: `Линия ${n}: коэффициент ФОТ 1–3 (пусто — из настроек)` };
    }
    const fixed = l.fixedPerVisit === undefined || l.fixedPerVisit === null || l.fixedPerVisit === '' ? 0 : Number(l.fixedPerVisit);
    if (!Number.isFinite(fixed) || fixed < 0 || fixed > 1e7) return { error: `Линия ${n}: фикс за визит ≥ 0` };
    const cats = parseIdList(l.categories, `Линия ${n}: категории`); if (cats.error) return cats;
    const svcs = parseIdList(l.services, `Линия ${n}: услуги`); if (svcs.error) return svcs;
    lines.push({ percent, base: l.base, payroll_multiplier: mult, fixed_per_visit: fixed, categories: cats.value, services: svcs.value });
  }
  const conflicts = schemeLineConflicts(lines);
  if (conflicts.length) return { error: conflictText(conflicts[0]) };
  return { value: { title, note: String(b.note || '').slice(0, 500), lines } };
}
function parsePayAssignment(b) {
  b = b || {};
  const staff = optInt(b.staffYcId), scheme = optInt(b.schemeId);
  if (!staff) return { error: 'Сотрудник — обязательное поле' };
  if (!scheme) return { error: 'Схема — обязательное поле' };
  const vf = b.validFrom || null, vt = b.validTo || null;
  if ((vf && !isDate(vf)) || (vt && !isDate(vt))) return { error: 'Дата в формате YYYY-MM-DD' };
  if (vf && vt && vf > vt) return { error: 'Период: начало позже конца' };
  return { value: { staff_yc_id: staff, scheme_id: scheme, valid_from: vf, valid_to: vt, note: String(b.note || '').slice(0, 500) } };
}
```

Заменить блок `// ── правила оплаты ──` с четырьмя ручками `/pay-rules` на:

```js
// ── схемы оплаты и назначения ──
router.get('/pay-schemes', async (req, res) => {
  const sid = req.user.salonId;
  try {
    const [schemes, assignments] = await Promise.all([store.listPaySchemes(sid), store.listPayAssignments(sid)]);
    res.json({ schemes: schemes.map(s => ({ ...s, assigned: [...new Set(assignments.filter(a => a.scheme_id === s.id).map(a => a.staff_yc_id))] })), assignments });
  } catch (e) { fail(res, 'pay-schemes')(e); }
});
router.post('/pay-schemes', async (req, res) => {
  const p = parsePayScheme(req.body); if (p.error) return res.status(400).json({ error: p.error });
  try { const id = await store.insertPayScheme(req.user.salonId, p.value); report.invalidate(req.user.salonId); res.json({ id }); } catch (e) { fail(res, 'pay-scheme create')(e); }
});
router.put('/pay-schemes/:id(\\d+)', async (req, res) => {
  const p = parsePayScheme(req.body); if (p.error) return res.status(400).json({ error: p.error });
  try {
    const ok = await store.updatePayScheme(req.user.salonId, idParam(req.params.id), p.value);
    if (!ok) return res.status(404).json({ error: 'Схема не найдена' });
    report.invalidate(req.user.salonId); res.json({ ok: true });
  } catch (e) { fail(res, 'pay-scheme update')(e); }
});
// Удаление назначенной схемы — 409, а не каскад: оплата — деньги, обнулять расчёт по врачу молча нельзя.
router.delete('/pay-schemes/:id(\\d+)', async (req, res) => {
  try {
    const r = await store.deletePayScheme(req.user.salonId, idParam(req.params.id));
    if (r === 'assigned') return res.status(409).json({ error: 'Схема назначена специалистам — сначала снимите назначения' });
    if (r !== 'deleted') return res.status(404).json({ error: 'Схема не найдена' });
    report.invalidate(req.user.salonId); res.json({ ok: true });
  } catch (e) { fail(res, 'pay-scheme delete')(e); }
});
async function checkAssignment(sid, v, selfId) {
  if (!(await store.paySchemeExists(sid, v.scheme_id))) return 'Схема не найдена';
  const clash = assignmentsOverlap(await store.listPayAssignments(sid), { ...v, id: selfId });
  if (clash.length) return `Период пересекается с назначением #${clash[0].id} (${clash[0].valid_from || '…'} — ${clash[0].valid_to || '…'})`;
  return null;
}
router.post('/pay-assignments', async (req, res) => {
  const p = parsePayAssignment(req.body); if (p.error) return res.status(400).json({ error: p.error });
  try {
    const err = await checkAssignment(req.user.salonId, p.value, null); if (err) return res.status(400).json({ error: err });
    const id = await store.insertPayAssignment(req.user.salonId, p.value); report.invalidate(req.user.salonId); res.json({ id });
  } catch (e) { fail(res, 'pay-assignment create')(e); }
});
router.put('/pay-assignments/:id(\\d+)', async (req, res) => {
  const p = parsePayAssignment(req.body); if (p.error) return res.status(400).json({ error: p.error });
  const id = idParam(req.params.id);
  try {
    const err = await checkAssignment(req.user.salonId, p.value, id); if (err) return res.status(400).json({ error: err });
    const ok = await store.updatePayAssignment(req.user.salonId, id, p.value);
    if (!ok) return res.status(404).json({ error: 'Назначение не найдено' });
    report.invalidate(req.user.salonId); res.json({ ok: true });
  } catch (e) { fail(res, 'pay-assignment update')(e); }
});
router.delete('/pay-assignments/:id(\\d+)', async (req, res) => {
  try {
    const ok = await store.deletePayAssignment(req.user.salonId, idParam(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Назначение не найдено' });
    report.invalidate(req.user.salonId); res.json({ ok: true });
  } catch (e) { fail(res, 'pay-assignment delete')(e); }
});
```

В `module.exports`: `module.exports.parsePayRule = parsePayRule;` → `module.exports.parsePayScheme = parsePayScheme; module.exports.parsePayAssignment = parsePayAssignment;`

- [ ] **Step 4: Запустить весь economics-сьют**

Run: `cd /root/loyalpro/backend && npx jest economics 2>&1 | tail -12`
Expected: все наборы PASS (`economics-*`), никаких упоминаний `parsePayRule`.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/routes/economics.js backend/economics-routes.test.js && git commit -m "feat(economics): API схем оплаты и назначений (/pay-schemes, /pay-assignments), /pay-rules снят

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Чистые помощники фронта — **Sonnet**

**Files:**
- Modify: `frontend/js/pages/economics-table.js:275-301` (заменить `ecoParseRuleForm`/`ecoRuleScopeParts`)
- Modify: `frontend/js/pages/economics-table.test.js:183-203, 224-227`

- [ ] **Step 1: Тесты** — удалить `ruleForm`, оба теста `ecoParseRuleForm` и тест `ecoRuleScopeParts`; на их место добавить:

```js
const schemeLine = (o) => ({ percent: '15', base: 'gross', mult: '', fixed: '', categories: [100], services: [], ...o });
const schemeForm = (o) => ({ title: ' Инъекции ', note: '', lines: [schemeLine()], names: {}, ...o });
test('ecoParseSchemeForm: тело ровно как у parsePayScheme бэкенда', () => {
  const r = plain(ctx.ecoParseSchemeForm(schemeForm({ lines: [schemeLine({ percent: '27,5', mult: '1,494', fixed: '500' }), schemeLine({ categories: [], services: ['10', 10, 11], base: 'net_of_materials' })] })));
  assert.deepStrictEqual(r, { value: { title: 'Инъекции', note: '', lines: [
    { percent: 27.5, base: 'gross', payrollMultiplier: 1.494, fixedPerVisit: 500, categories: [100], services: [] },
    { percent: 15, base: 'net_of_materials', payrollMultiplier: null, fixedPerVisit: 0, categories: [], services: [10, 11] },
  ] } });
});
test('ecoParseSchemeForm: ошибки', () => {
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ title: '' })).error, /назван/i);
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ lines: [] })).error, /лини/i);
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ lines: [schemeLine({ percent: '101' })] })).error, /Линия 1: процент/);
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ lines: [schemeLine({ percent: 'abc' })] })).error, /процент/);
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ lines: [schemeLine({ base: 'x' })] })).error, /баз/i);
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ lines: [schemeLine({ mult: '0,9' })] })).error, /ФОТ/);
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ lines: [schemeLine({ fixed: '-5' })] })).error, /фикс/i);
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ lines: [schemeLine(), schemeLine()] })).error, /#100 стоит в линиях 1 и 2/);
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ lines: [schemeLine({ categories: [] }), schemeLine({ categories: [] })] })).error, /остальные услуги/);
  assert.ok(ctx.ecoParseSchemeForm(schemeForm({ note: 'я'.repeat(501) })).error);
});
test('ecoSchemeConflictText подставляет имена из справочника', () => {
  const names = { services: new Map([['5', 'Revi Strong 2 ml']]), categories: new Map([['100', 'Инъекционная косметология']]) };
  assert.strictEqual(ctx.ecoSchemeConflictText({ kind: 'service', id: 5, lines: [0, 2] }, names), 'Услуга «Revi Strong 2 ml» стоит в линиях 1 и 3 — оставьте её в одной');
  assert.strictEqual(ctx.ecoSchemeConflictText({ kind: 'category', id: 100, lines: [0, 1] }, names), 'Категория «Инъекционная косметология» стоит в линиях 1 и 2 — оставьте её в одной');
  assert.strictEqual(ctx.ecoSchemeConflictText({ kind: 'category', id: 7, lines: [0, 1] }, names), 'Категория #7 стоит в линиях 1 и 2 — оставьте её в одной');
  assert.strictEqual(ctx.ecoSchemeConflictText({ kind: 'fallback', id: null, lines: [1, 3] }, names), 'Линия «остальные услуги» может быть только одна (линии 2 и 4)');
});
test('ecoLineText / ecoLineIsFallback / ecoPlural', () => {
  assert.strictEqual(ctx.ecoLineText({ percent: 15, base: 'gross', payroll_multiplier: null, fixed_per_visit: 0, categories: [1, 2, 3], services: [7, 8] }), '15 % от выручки · 3 категории, 2 услуги');
  assert.strictEqual(ctx.ecoLineText({ percent: 20, base: 'net_of_materials', payroll_multiplier: 1.494, fixed_per_visit: 500, categories: [], services: [7] }), '20 % от выручки − материалы · ФОТ ×1,494 · фикс 500 ₽ · 1 услуга');
  assert.strictEqual(ctx.ecoLineText({ percent: 10, base: 'gross', categories: [], services: [] }), '10 % от выручки · остальные услуги');
  assert.strictEqual(ctx.ecoLineIsFallback({ categories: [], services: [] }), true);
  assert.strictEqual(ctx.ecoLineIsFallback({ categories: [1], services: [] }), false);
  assert.strictEqual(ctx.ecoPlural(5, 'категория', 'категории', 'категорий'), 'категорий');
  assert.strictEqual(ctx.ecoPlural(21, 'услуга', 'услуги', 'услуг'), 'услуга');
  assert.strictEqual(ctx.ecoPlural(12, 'услуга', 'услуги', 'услуг'), 'услуг');
});
test('ecoParseAssignmentForm: тело как у parsePayAssignment; ошибки', () => {
  assert.deepStrictEqual(plain(ctx.ecoParseAssignmentForm({ staff: '5', scheme: '3', from: '2026-02-01', to: '', note: ' n ' })), { value: { staffYcId: 5, schemeId: 3, validFrom: '2026-02-01', validTo: null, note: 'n' } });
  assert.match(ctx.ecoParseAssignmentForm({ staff: '', scheme: '3', from: '', to: '', note: '' }).error, /сотрудник/i);
  assert.match(ctx.ecoParseAssignmentForm({ staff: '5', scheme: '', from: '', to: '', note: '' }).error, /схем/i);
  assert.match(ctx.ecoParseAssignmentForm({ staff: '5', scheme: '3', from: '2026-13-01', to: '', note: '' }).error, /дат/i);
  assert.match(ctx.ecoParseAssignmentForm({ staff: '5', scheme: '3', from: '2026-05-02', to: '2026-05-01', note: '' }).error, /период/i);
});
test('ecoAssignmentsOverlap и ecoStaffWithoutScheme', () => {
  const ex = [{ id: 1, staff_yc_id: 5, scheme_id: 1, valid_from: '2026-01-01', valid_to: '2026-06-30' }, { id: 2, staff_yc_id: 5, scheme_id: 2, valid_from: '2026-07-01', valid_to: null }];
  assert.deepStrictEqual(plain(ctx.ecoAssignmentsOverlap(ex, { id: null, staff_yc_id: 5, valid_from: '2026-06-30', valid_to: null })).map(a => a.id), [1, 2]);
  assert.deepStrictEqual(plain(ctx.ecoAssignmentsOverlap(ex, { id: 2, staff_yc_id: 5, valid_from: '2026-07-01', valid_to: null })), []);
  assert.deepStrictEqual(plain(ctx.ecoAssignmentsOverlap(ex, { id: null, staff_yc_id: 6, valid_from: null, valid_to: null })), []);
  const staff = [{ id: 5, name: 'Б', is_active: true }, { id: 6, name: 'В', is_active: true }, { id: 7, name: 'Г', is_active: false }];
  assert.deepStrictEqual(plain(ctx.ecoStaffWithoutScheme(staff, ex, '2026-10-19')), [{ id: 6, name: 'В', is_active: true }]);
  assert.deepStrictEqual(plain(ctx.ecoStaffWithoutScheme(staff, [], '2026-10-19')).map(s => s.id), [5, 6]);
});
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `cd /root/loyalpro && node --test frontend/js/pages/economics-table.test.js 2>&1 | tail -15`
Expected: FAIL (`ecoParseSchemeForm is not a function`).

- [ ] **Step 3: Заменить `ecoParseRuleForm` и `ecoRuleScopeParts` в `economics-table.js`** на:

```js
// ── Схемы оплаты труда (зеркало parsePayScheme / pay-rules.js бэкенда) ──
function ecoPlural(n, one, few, many) { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? one : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many); }
function ecoLineIsFallback(l) { return !((l && l.services) || []).length && !((l && l.categories) || []).length; }
/** Конфликты линий: [{kind:'service'|'category'|'fallback', id, lines:[i,j]}] — та же логика, что schemeLineConflicts на бэкенде. */
function ecoSchemeConflicts(lines) {
  const out = []; const seen = { service: new Map(), category: new Map() }; const fallbacks = [];
  (lines || []).forEach((l, i) => {
    for (const [kind, key] of [['service', 'services'], ['category', 'categories']]) {
      for (const id of (l[key] || [])) {
        const k = String(id); const first = seen[kind].get(k);
        if (first === undefined) seen[kind].set(k, i);
        else if (first !== i && !out.some(c => c.kind === kind && String(c.id) === k)) out.push({ kind, id: Number(id), lines: [first, i] });
      }
    }
    if (ecoLineIsFallback(l)) fallbacks.push(i);
  });
  if (fallbacks.length > 1) out.push({ kind: 'fallback', id: null, lines: fallbacks.slice(0, 2) });
  return out;
}
/** names: {services: Map(id→title), categories: Map(id→title)} — имена вместо «#id», когда известны. */
function ecoSchemeConflictText(c, names) {
  const [a, b] = c.lines.map(i => i + 1);
  if (c.kind === 'fallback') return `Линия «остальные услуги» может быть только одна (линии ${a} и ${b})`;
  const map = (names || {})[c.kind === 'service' ? 'services' : 'categories'];
  const nm = map && map.get ? map.get(String(c.id)) : null;
  return `${c.kind === 'service' ? 'Услуга' : 'Категория'} ${nm ? `«${nm}»` : `#${c.id}`} стоит в линиях ${a} и ${b} — оставьте её в одной`;
}
/** Форма схемы → тело POST/PUT /pay-schemes. f: {title, note, lines:[{percent, base, mult, fixed, categories:[ids], services:[ids]}], names}. */
function ecoParseSchemeForm(f) {
  const title = String(f.title || '').trim();
  if (!title) return { error: 'Укажите название схемы' };
  if (title.length > 120) return { error: 'Название — не длиннее 120 символов' };
  const src = f.lines || [];
  if (!src.length) return { error: 'Добавьте хотя бы одну линию' };
  if (src.length > 50) return { error: 'Не больше 50 линий' };
  const ids = (arr) => [...new Set((arr || []).map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0))];
  const lines = [];
  for (const [i, l] of src.entries()) {
    const n = i + 1;
    const percent = ecoStrictNumber(l.percent);
    if (!(percent >= 0 && percent <= 100)) return { error: `Линия ${n}: процент — число от 0 до 100` };
    if (l.base !== 'gross' && l.base !== 'net_of_materials') return { error: `Линия ${n}: выберите базу` };
    const multRaw = String(l.mult === null || l.mult === undefined ? '' : l.mult).trim();
    const mult = multRaw === '' ? null : ecoStrictNumber(multRaw);
    if (mult !== null && !(mult >= 1 && mult <= 3)) return { error: `Линия ${n}: коэффициент ФОТ — от 1 до 3 (пусто — из настроек)` };
    const fixedRaw = String(l.fixed === null || l.fixed === undefined ? '' : l.fixed).trim();
    const fixed = fixedRaw === '' ? 0 : ecoStrictNumber(fixedRaw);
    if (!(fixed >= 0 && fixed <= 1e7)) return { error: `Линия ${n}: фикс за визит — число от 0` };
    lines.push({ percent, base: l.base, payrollMultiplier: mult, fixedPerVisit: fixed, categories: ids(l.categories), services: ids(l.services) });
  }
  const c = ecoSchemeConflicts(lines);
  if (c.length) return { error: ecoSchemeConflictText(c[0], f.names) };
  const note = String(f.note || '').trim();
  if (note.length > 500) return { error: 'Заметка — не длиннее 500 символов' };
  return { value: { title, note, lines } };
}
/** Подпись линии в карточке схемы (линия в форме API: payroll_multiplier, fixed_per_visit). */
function ecoLineText(l) {
  const parts = [`${ecoNum(Number(l.percent), Number.isInteger(Number(l.percent)) ? 0 : 2)} % ${l.base === 'net_of_materials' ? 'от выручки − материалы' : 'от выручки'}`];
  const m = Number(l.payroll_multiplier); if (m > 0) parts.push(`ФОТ ×${ecoNum(m, 3).replace(/,?0+$/, '')}`);
  const f = Number(l.fixed_per_visit); if (f > 0) parts.push(`фикс ${ecoMoney(f)}`);
  const nc = (l.categories || []).length, ns = (l.services || []).length; const scope = [];
  if (nc) scope.push(`${nc} ${ecoPlural(nc, 'категория', 'категории', 'категорий')}`);
  if (ns) scope.push(`${ns} ${ecoPlural(ns, 'услуга', 'услуги', 'услуг')}`);
  parts.push(scope.length ? scope.join(', ') : 'остальные услуги');
  return parts.join(' · ');
}
/** Форма назначения → тело POST/PUT /pay-assignments. */
function ecoParseAssignmentForm(f) {
  const staff = ecoOptId(f.staff, 'Сотрудник'); if (staff.error) return staff;
  if (staff.value === null) return { error: 'Выберите сотрудника' };
  const scheme = ecoOptId(f.scheme, 'Схема'); if (scheme.error) return scheme;
  if (scheme.value === null) return { error: 'Выберите схему' };
  const from = String(f.from || '').trim() || null, to = String(f.to || '').trim() || null;
  if ((from && !ecoIsDate(from)) || (to && !ecoIsDate(to))) return { error: 'Неверная дата' };
  if (from && to && from > to) return { error: 'Период: начало позже конца' };
  const note = String(f.note || '').trim();
  if (note.length > 500) return { error: 'Заметка — не длиннее 500 символов' };
  return { value: { staffYcId: staff.value, schemeId: scheme.value, validFrom: from, validTo: to, note } };
}
/** Назначения того же сотрудника с пересекающимся периодом (NULL — бесконечность); cand.id исключается. */
function ecoAssignmentsOverlap(existing, cand) {
  const d = (v) => (v ? String(v).slice(0, 10) : null);
  const from = d(cand.valid_from) || '0000-00-00', to = d(cand.valid_to) || '9999-12-31';
  return (existing || []).filter(a => String(a.staff_yc_id) === String(cand.staff_yc_id) && !(cand.id !== null && cand.id !== undefined && String(a.id) === String(cand.id)))
    .filter(a => (d(a.valid_from) || '0000-00-00') <= to && (d(a.valid_to) || '9999-12-31') >= from);
}
/** Активные сотрудники справочника без назначения, действующего на дату today ('YYYY-MM-DD'). */
function ecoStaffWithoutScheme(staff, assignments, today) {
  const d = (v) => (v ? String(v).slice(0, 10) : null);
  const active = (a) => (!d(a.valid_from) || d(a.valid_from) <= today) && (!d(a.valid_to) || d(a.valid_to) >= today);
  return (staff || []).filter(s => s.is_active !== false && !(assignments || []).some(a => String(a.staff_yc_id) === String(s.id) && active(a)));
}
```

- [ ] **Step 4: Запустить node-тесты фронта**

Run: `cd /root/loyalpro && node --test frontend/js/pages/economics-table.test.js 2>&1 | tail -8`
Expected: все PASS (тест «все `<script>` в одном vm» тоже зелёный — имена не конфликтуют). Если `ecoLineText` для `1.494` даёт не `1,494`, поправить регэксп среза нулей (ожидание теста менять нельзя).

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add frontend/js/pages/economics-table.js frontend/js/pages/economics-table.test.js && git commit -m "feat(economics): чистые помощники фронта для схем оплаты и назначений

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: UI вкладки «Оплата труда» — **Opus**

**Files:**
- Modify: `frontend/js/pages/economics.js:304-375` (заменить блок `// ── Оплата труда ──` до `// ── Настройки ──`; `ecoPayrollCheck` оставить как есть)
- Modify: `frontend/css/features.css` (после строки 1249)
- Modify: `frontend/index.html:26,2755,2756` — бамп `?v=`

- [ ] **Step 1: Заменить в `economics.js` функции `ecoScopeText`, `ecoLoadPay`, `ecoEditRule`, `ecoSaveRule`, `ecoDeleteRule`** (функцию `ecoPayrollCheck` и `_ecoPcSeq` не трогать) на:

```js
// ── Оплата труда: схемы и назначения (спека 2026-10-19-economics-pay-schemes-design.md §5) ──
let _ecoPaySeq = 0;
function ecoSchemeById(id) { return (_eco.schemes || []).find(s => Number(s.id) === Number(id)) || null; }
function ecoPayNames(d) {
  return { staff: new Map((d.staff || []).map(s => [String(s.id), s.name])), services: new Map((d.services || []).map(s => [String(s.id), s.title])), categories: new Map((d.categories || []).map(c => [String(c.id), c.title])) };
}
async function ecoLoadPay() {
  const el = document.getElementById('ecoPay'); const seq = ++_ecoPaySeq;
  try {
    const [r, d, st] = await Promise.all([api('GET', '/api/economics/pay-schemes'), ecoDicts(), api('GET', '/api/economics/settings')]);
    if (seq !== _ecoPaySeq) return;
    el.className = '';
    _eco.schemes = r.schemes || []; _eco.assignments = r.assignments || []; _eco.payDicts = d; _eco.schemeDraft = null;
    _eco.salonMult = Number(st.settings && st.settings.payroll_multiplier) || 1.3;
    const nm = ecoPayNames(d);
    const staffName = (id) => nm.staff.get(String(id)) || `id ${id}`;
    const cards = _eco.schemes.map(s => `<div class="card eco-scheme"><div class="eco-scheme-head"><div><div class="eco-strong">${esc(s.title)}</div><div class="eco-kpi-sub">${s.assigned.length ? 'назначена: ' + esc(s.assigned.map(staffName).join(', ')) : 'никому не назначена'}${s.note ? ' · ' + esc(s.note) : ''}</div></div><div class="eco-actions"><button class="btn btn-sm" onclick="ecoEditScheme(${Number(s.id)})">Изменить</button><button class="btn btn-sm" onclick="ecoDeleteScheme(${Number(s.id)})">Удалить</button></div></div><ul class="eco-lines">${(s.lines || []).map(l => `<li>${esc(ecoLineText(l))}</li>`).join('')}</ul></div>`).join('');
    const aRows = _eco.assignments.map(a => `<tr><td>${esc(staffName(a.staff_yc_id))}</td><td>${esc((ecoSchemeById(a.scheme_id) || {}).title || `схема #${a.scheme_id}`)}</td><td>${esc(a.valid_from || '…')} — ${esc(a.valid_to || '…')}</td><td>${esc(a.note || '')}</td><td><div class="eco-actions"><button class="btn btn-sm" onclick="ecoEditAssignment(${Number(a.id)})">Изменить</button><button class="btn btn-sm" onclick="ecoDeleteAssignment(${Number(a.id)})">Удалить</button></div></td></tr>`).join('');
    const without = ecoStaffWithoutScheme(d.staff, _eco.assignments, ecoTodayMsk());
    el.innerHTML = `<div class="bc-head"><div><div class="bc-head-title">👩‍⚕️ Схемы оплаты</div><div class="bc-head-sub">Схема — линии «категории/услуги → процент». Услуга, названная прямо, важнее категории; категория важнее линии «остальные услуги»</div></div><button class="btn btn-sm btn-pri" onclick="ecoEditScheme(null)">+ Схема</button></div>
      <div id="ecoSchemeForm"></div>
      ${cards || '<div class="card"><div class="empty">Схем нет — создайте схему и назначьте её специалистам, иначе оплата врача в отчёте равна 0</div></div>'}
      <div class="bc-head" style="margin-top:18px"><div><div class="bc-head-title">Назначение специалистам</div><div class="bc-head-sub">Одна схема — любому числу специалистов; периоды одного специалиста не пересекаются</div></div><button class="btn btn-sm btn-pri" onclick="ecoEditAssignment(null)">+ Назначить</button></div>
      <div id="ecoAssignForm"></div>
      <div class="card eco-card-flush"><div class="tw"><table class="mtbl eco-tbl"><thead><tr><th>Сотрудник</th><th>Схема</th><th>Период</th><th>Заметка</th><th></th></tr></thead><tbody>${aRows || '<tr><td colspan="5" class="empty">Назначений нет</td></tr>'}</tbody></table></div></div>
      ${without.length ? `<div class="eco-kpi-sub" style="margin-top:6px">Без схемы на сегодня: ${esc(without.map(s => s.name).join(', '))} — в отчёте у них «нет правила оплаты»</div>` : ''}
      <div class="card" style="margin-top:14px"><div class="bc-head"><div class="bc-head-title">Сверка с YClients</div><div><input type="month" id="ecoPcMonth" value="${escAttr(ecoTodayMsk().slice(0, 7))}"> <button class="btn btn-sm" onclick="ecoPayrollCheck()">Сверить</button></div></div><div id="ecoPcBody" class="eco-kpi-sub">Наш расчёт оплаты по процедурам против итога «Расчёт зарплат» YClients за месяц. Ничего не пересчитывает; по одному запросу в YClients на сотрудника.</div></div>`;
  } catch (e) { if (seq === _ecoPaySeq) el.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
}
// Редактор схемы — черновик в _eco.schemeDraft; поля пишут в него по oninput, перерисовка
// целиком только на добавление/удаление линии (иначе теряется фокус), выбор целей
// перерисовывает один пикер.
function ecoNewLine() { return { percent: '30', base: 'gross', mult: '', fixed: '', categories: [], services: [] }; }
function ecoLineFromApi(l) {
  return { percent: String(Number(l.percent)), base: l.base, mult: l.payroll_multiplier === null || l.payroll_multiplier === undefined ? '' : String(Number(l.payroll_multiplier)),
    fixed: Number(l.fixed_per_visit) ? String(Number(l.fixed_per_visit)) : '', categories: (l.categories || []).map(Number), services: (l.services || []).map(Number) };
}
function ecoEditScheme(id) {
  const s = id ? ecoSchemeById(id) : null;
  if (id && !s) return notify('Схема не найдена — обновите вкладку', 'err');
  _eco.schemeDraft = { id: id ? Number(id) : null, title: s ? s.title : '', note: s ? s.note || '' : '', lines: s ? (s.lines || []).map(ecoLineFromApi) : [ecoNewLine()] };
  ecoRenderSchemeForm();
  const t = document.getElementById('ecoSchTitle'); if (t) t.focus();
}
function ecoRenderSchemeForm() {
  const dr = _eco.schemeDraft; const box = document.getElementById('ecoSchemeForm'); if (!dr || !box) return;
  const lines = dr.lines.map((l, i) => `<div class="card eco-line"><div class="eco-line-head"><div class="eco-strong">Линия ${i + 1} <span class="eco-kpi-sub" id="ecoLineKind-${i}">${ecoLineIsFallback(l) ? '· остальные услуги' : ''}</span></div><button class="btn btn-sm" onclick="ecoRemoveLine(${i})">Убрать</button></div>
    <div class="eco-form">
      <div class="fg"><label class="fl">Процент</label><input type="text" inputmode="decimal" value="${escAttr(l.percent)}" oninput="ecoLineField(${i},'percent',this.value)"></div>
      <div class="fg"><label class="fl">База</label><select onchange="ecoLineField(${i},'base',this.value)"><option value="gross" ${l.base !== 'net_of_materials' ? 'selected' : ''}>от выручки</option><option value="net_of_materials" ${l.base === 'net_of_materials' ? 'selected' : ''}>выручка − материалы</option></select></div>
      <div class="fg"><label class="fl">Коэффициент ФОТ</label><input type="text" inputmode="decimal" placeholder="из настроек: ${escAttr(String(_eco.salonMult))}" value="${escAttr(l.mult)}" oninput="ecoLineField(${i},'mult',this.value)"></div>
      <div class="fg"><label class="fl">Фикс за визит, ₽</label><input type="text" inputmode="decimal" value="${escAttr(l.fixed)}" oninput="ecoLineField(${i},'fixed',this.value)"></div>
    </div>
    ${ecoPickerHtml(i, 'categories', 'Категории')}${ecoPickerHtml(i, 'services', 'Услуги')}</div>`).join('');
  box.innerHTML = `<div class="card eco-detail"><div class="eco-form">
    <div class="fg"><label class="fl">Название схемы</label><input id="ecoSchTitle" maxlength="120" value="${escAttr(dr.title)}" oninput="_eco.schemeDraft.title=this.value"></div>
    <div class="fg"><label class="fl">Заметка</label><input maxlength="500" value="${escAttr(dr.note)}" oninput="_eco.schemeDraft.note=this.value"></div></div>
    ${lines}
    <div class="eco-kpi-sub" style="margin-top:8px">Приоритет: услуга, названная в линии прямо, важнее категории; категория важнее линии «остальные услуги» (линия без выбранных категорий и услуг — не больше одной). Одна услуга или категория не может стоять в двух линиях. Пустой коэффициент ФОТ — множитель из настроек.</div>
    <div class="eco-actions" style="margin-top:10px"><button class="btn btn-sm" onclick="ecoAddLine()">+ Линия</button><button class="btn btn-sm btn-pri" id="ecoSchSave" onclick="ecoSaveScheme()">Сохранить</button><button class="btn btn-sm" onclick="ecoCancelScheme()">Отмена</button></div></div>`;
}
function ecoCancelScheme() { _eco.schemeDraft = null; const b = document.getElementById('ecoSchemeForm'); if (b) b.innerHTML = ''; }
function ecoLineField(i, key, value) { const l = _eco.schemeDraft && _eco.schemeDraft.lines[i]; if (l) l[key] = value; }
function ecoAddLine() { if (!_eco.schemeDraft) return; _eco.schemeDraft.lines.push(ecoNewLine()); ecoRenderSchemeForm(); }
function ecoRemoveLine(i) { if (!_eco.schemeDraft) return; _eco.schemeDraft.lines.splice(i, 1); ecoRenderSchemeForm(); }
function ecoPickerList(kind) { const d = _eco.payDicts || {}; return (kind === 'services' ? d.services : d.categories) || []; }
function ecoPickerCatTitle(kind, x) {
  if (kind !== 'services' || x.category_id === null || x.category_id === undefined) return '';
  const c = ((_eco.payDicts || {}).categories || []).find(y => Number(y.id) === Number(x.category_id));
  return c ? ` <span class="eco-kpi-sub">(${esc(c.title)})</span>` : '';
}
function ecoChipsHtml(i, kind) {
  const l = _eco.schemeDraft.lines[i]; const byId = new Map(ecoPickerList(kind).map(x => [Number(x.id), x]));
  return l[kind].map(id => `<span class="eco-chip">${esc(byId.has(id) ? ecoDictLabel(byId.get(id)) : `id ${id}`)}<button type="button" title="Убрать" onclick="ecoPickerToggle(${i},'${kind}',${id})">×</button></span>`).join('') || '<span class="eco-kpi-sub">ничего не выбрано</span>';
}
function ecoPickerListHtml(i, kind, q) {
  const l = _eco.schemeDraft.lines[i]; const chosen = new Set(l[kind].map(Number)); const needle = String(q || '').trim().toLowerCase();
  const items = ecoPickerList(kind).filter(x => !needle || ecoDictLabel(x).toLowerCase().includes(needle));
  if (!items.length) return '<div class="eco-kpi-sub" style="padding:6px">Ничего не найдено</div>';
  return items.map(x => `<label class="eco-pick"><input type="checkbox" ${chosen.has(Number(x.id)) ? 'checked' : ''} onchange="ecoPickerToggle(${i},'${kind}',${Number(x.id)})"> ${esc(ecoDictLabel(x))}${ecoPickerCatTitle(kind, x)}</label>`).join('');
}
function ecoPickerHtml(i, kind, label) {
  return `<div class="eco-picker"><label class="fl">${label}</label><div class="eco-chips" id="ecoChips-${i}-${kind}">${ecoChipsHtml(i, kind)}</div><input type="text" placeholder="Поиск…" id="ecoPkQ-${i}-${kind}" oninput="ecoPickerFilter(${i},'${kind}',this.value)"><div class="eco-picker-list" id="ecoPk-${i}-${kind}">${ecoPickerListHtml(i, kind, '')}</div></div>`;
}
function ecoPickerFilter(i, kind, q) { const el = document.getElementById(`ecoPk-${i}-${kind}`); if (el) el.innerHTML = ecoPickerListHtml(i, kind, q); }
function ecoPickerToggle(i, kind, id) {
  const l = _eco.schemeDraft && _eco.schemeDraft.lines[i]; if (!l) return;
  const n = Number(id);
  l[kind] = l[kind].includes(n) ? l[kind].filter(x => x !== n) : [...l[kind], n];
  const q = document.getElementById(`ecoPkQ-${i}-${kind}`); ecoPickerFilter(i, kind, q ? q.value : '');
  const chips = document.getElementById(`ecoChips-${i}-${kind}`); if (chips) chips.innerHTML = ecoChipsHtml(i, kind);
  const kindEl = document.getElementById(`ecoLineKind-${i}`); if (kindEl) kindEl.textContent = ecoLineIsFallback(l) ? '· остальные услуги' : '';
}
async function ecoSaveScheme() {
  const dr = _eco.schemeDraft; if (!dr) return;
  const p = ecoParseSchemeForm({ title: dr.title, note: dr.note, lines: dr.lines, names: ecoPayNames(_eco.payDicts || {}) });
  if (p.error) return notify(p.error, 'err');
  const btn = document.getElementById('ecoSchSave'); if (btn) btn.disabled = true;
  try {
    await api(dr.id ? 'PUT' : 'POST', dr.id ? `/api/economics/pay-schemes/${dr.id}` : '/api/economics/pay-schemes', p.value);
    _eco.schemeDraft = null; _eco.report = null; notify('Схема сохранена'); ecoLoadPay();
  } catch (e) { if (btn) btn.disabled = false; notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoDeleteScheme(id) {
  const s = ecoSchemeById(id);
  if (s && s.assigned && s.assigned.length) return notify('Схема назначена специалистам — сначала снимите назначения', 'err');
  if (!confirm('Удалить схему?')) return;
  try { await api('DELETE', `/api/economics/pay-schemes/${Number(id)}`); _eco.report = null; ecoLoadPay(); } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
function ecoEditAssignment(id) {
  const d = _eco.payDicts || {};
  const a = id ? (_eco.assignments || []).find(x => Number(x.id) === Number(id)) : { staff_yc_id: '', scheme_id: '', valid_from: '', valid_to: '', note: '' };
  if (!a) return notify('Назначение не найдено — обновите вкладку', 'err');
  const opt = (list, sel, label, text) => `<option value="">${label}</option>` + (sel && !list.some(i => String(i.id) === String(sel)) ? `<option value="${escAttr(String(sel))}" selected>id ${esc(String(sel))} (нет в справочнике)</option>` : '') + list.map(i => `<option value="${escAttr(String(i.id))}" ${String(sel) === String(i.id) ? 'selected' : ''}>${esc(text(i))}</option>`).join('');
  document.getElementById('ecoAssignForm').innerHTML = `<div class="card eco-detail"><div class="eco-form">
    <div class="fg"><label class="fl">Сотрудник</label><select id="ecoAStaff">${opt(d.staff || [], a.staff_yc_id, '— выберите —', ecoDictLabel)}</select></div>
    <div class="fg"><label class="fl">Схема</label><select id="ecoAScheme">${opt(_eco.schemes || [], a.scheme_id, '— выберите —', s => s.title)}</select></div>
    <div class="fg"><label class="fl">Действует с</label><input id="ecoAFrom" type="date" value="${escAttr(a.valid_from || '')}"></div>
    <div class="fg"><label class="fl">по</label><input id="ecoATo" type="date" value="${escAttr(a.valid_to || '')}"></div>
    <div class="fg"><label class="fl">Заметка</label><input id="ecoANote" maxlength="500" value="${escAttr(a.note || '')}"></div></div>
    <div class="eco-kpi-sub" style="margin-top:6px">Период можно не заполнять — схема действует бессрочно.</div>
    <div class="eco-actions" style="margin-top:10px"><button class="btn btn-sm btn-pri" id="ecoASave" onclick="ecoSaveAssignment(${id ? Number(id) : 'null'})">Сохранить</button><button class="btn btn-sm" onclick="document.getElementById('ecoAssignForm').innerHTML=''">Отмена</button></div></div>`;
}
async function ecoSaveAssignment(id) {
  const v = (i) => document.getElementById(i).value;
  const p = ecoParseAssignmentForm({ staff: v('ecoAStaff'), scheme: v('ecoAScheme'), from: v('ecoAFrom'), to: v('ecoATo'), note: v('ecoANote') });
  if (p.error) return notify(p.error, 'err');
  const clash = ecoAssignmentsOverlap(_eco.assignments || [], { id, staff_yc_id: p.value.staffYcId, valid_from: p.value.validFrom, valid_to: p.value.validTo });
  if (clash.length) return notify(`Период пересекается с назначением «${(ecoSchemeById(clash[0].scheme_id) || {}).title || '#' + clash[0].scheme_id}» (${clash[0].valid_from || '…'} — ${clash[0].valid_to || '…'})`, 'err');
  const btn = document.getElementById('ecoASave'); if (btn) btn.disabled = true;
  try {
    await api(id ? 'PUT' : 'POST', id ? `/api/economics/pay-assignments/${Number(id)}` : '/api/economics/pay-assignments', p.value);
    _eco.report = null; notify('Назначение сохранено'); ecoLoadPay();
  } catch (e) { if (btn) btn.disabled = false; notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoDeleteAssignment(id) {
  if (!confirm('Снять назначение? Оплата врача за визиты этого периода в отчёте станет 0.')) return;
  try { await api('DELETE', `/api/economics/pay-assignments/${Number(id)}`); _eco.report = null; ecoLoadPay(); } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
```

Убедиться, что в `_eco` (строка 6) ничего добавлять не нужно: новые поля (`schemes`, `assignments`, `payDicts`, `schemeDraft`, `salonMult`) создаются динамически.

- [ ] **Step 2: CSS** — добавить в `frontend/css/features.css` после строки `@media(max-width:700px){.eco-summary…}` (1249):

```css
.eco-scheme{margin-bottom:10px}.eco-scheme-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap}
.eco-lines{margin:8px 0 0;padding-left:18px;font-size:13px;line-height:1.5}
.eco-line{margin-top:10px}.eco-line-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}
.eco-picker{margin-top:10px}.eco-picker>input[type=text]{width:100%;margin:6px 0;box-sizing:border-box}
.eco-chips{display:flex;flex-wrap:wrap;gap:6px;min-height:24px;align-items:center}
.eco-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:12px;background:var(--bg);border:1px solid var(--bd);font-size:12.5px}
.eco-chip button{border:0;background:none;cursor:pointer;color:var(--t3);font-size:14px;line-height:1;padding:0 0 0 2px}
.eco-picker-list{max-height:180px;overflow:auto;border:1px solid var(--bd);border-radius:8px;padding:4px 8px}
.eco-pick{display:flex;gap:6px;align-items:center;padding:3px 0;font-size:13px;cursor:pointer}
```

- [ ] **Step 3: Бамп версий в `index.html`** — строка 26: `features.css?v=2026-10-19-eco6-notify1` → `features.css?v=2026-10-19-eco7-notify1`; строки 2755–2756: `economics-table.js?v=2026-10-19d` → `?v=2026-10-19e`, `economics.js?v=2026-10-19d` → `?v=2026-10-19e`.

- [ ] **Step 4: Node-тест общей области и синтаксис**

Run: `cd /root/loyalpro && node --check frontend/js/pages/economics.js && node --test frontend/js/pages/economics-table.test.js 2>&1 | tail -5`
Expected: без ошибок, тесты PASS (в т. ч. «все `<script>` index.html в одном vm-контексте»).

- [ ] **Step 5: Живой прогон в браузере (MCP Playwright)** — зайти владельцем на дев `http://localhost:3001`, открыть «💰 Экономика» → «Оплата труда»:
  1. «+ Схема» → название «Тест», линия 1: 15 %, выбрать 2 категории через поиск (чипы появились); «+ Линия» → линия 2: 20 %, база «выручка − материалы», ФОТ 1,494, выбрать 1 услугу; «Сохранить» → карточка схемы с двумя подписями линий.
  2. Попытка сохранить схему с одной категорией в двух линиях → уведомление «Категория «…» стоит в линиях 1 и 2 — оставьте её в одной», запрос не ушёл.
  3. «+ Назначить» → сотрудник, схема «Тест», с 2026-10-01 → строка в таблице; повторное назначение того же сотрудника без дат → уведомление о пересечении.
  4. «Удалить» схему «Тест» при живом назначении → уведомление «назначена специалистам»; снять назначение → удалить схему → список пуст.
  5. Скриншоты обеих тем и ширины 390px: `/tmp/eco-pay-light.png`, `/tmp/eco-pay-dark.png`, `/tmp/eco-pay-390.png`; на 390px чипы и списки не вылезают за карточку.
  В консоли браузера ошибок нет.

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add frontend/js/pages/economics.js frontend/css/features.css frontend/index.html && git commit -m "feat(economics): вкладка «Оплата труда» — схемы с линиями и мультивыбором, назначения специалистам

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Документация, перенос дев-данных, сверка с базовым снимком — **Sonnet**

**Files:**
- Modify: `CLAUDE.md` (раздел «Экономика процедур», буллет про `fixed_per_visit`/`pay-rules.doctorPay`)
- Modify: `docs/2026-10-19-economics-acceptance.md:8`
- Modify: `docs/superpowers/specs/2026-10-18-procedure-economics-design.md:89` (§3.3 — ссылка на новую спеку)

- [ ] **Step 1: Перезапустить дев и завести схемы по §7 спеки** (вместо двух старых правил врача 5708379)

Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 5`
Через UI (MCP Playwright) или API владельца создать:
- схему «Боташев до мая»: линия 15 % от выручки, категория 9536366; назначение 5708379 с 2026-02-01 по 2026-04-30;
- схему «Боташев»: линия 15 % категория 9536366 + линия 20 % категория 15394116; назначение 5708379 с 2026-05-01.
Проверить SQL (MCP postgres): `SELECT id, title, jsonb_array_length(lines) FROM pay_schemes; SELECT staff_yc_id, scheme_id, valid_from, valid_to FROM pay_scheme_assignments;` → 2 схемы, 2 назначения.

- [ ] **Step 2: Сверить с базовым снимком Task 1**

Run (тот же скрипт, что в Task 1 Step 1):
```bash
cd /root/loyalpro/backend && node -e "
const report=require('./services/economics/report'); const {db}=require('./db');
(async()=>{ const salon=await db.oneOrNone('SELECT * FROM salons WHERE id=1');
const r=await report.buildReport(salon,'2026-09-01','2026-09-30');
const by={}; for(const x of r.rows){ by[x.staff_yc_id]=Math.round(((by[x.staff_yc_id]||0)+x.doctor_pay)*100)/100; }
console.log(JSON.stringify(by)); process.exit(0); })().catch(e=>{console.error(e);process.exit(1);});" > /tmp/eco-pay-after-2026-09.json; diff /tmp/eco-pay-baseline-2026-09.json /tmp/eco-pay-after-2026-09.json && echo SAME
```
Expected: `SAME` — суммы по всем врачам за сентябрь совпали со снимком до переработки. Расхождение = дефект резолва (не «ожидаемая разница»): остановиться и разобраться.

- [ ] **Step 3: CLAUDE.md** — в разделе «Экономика процедур» буллет, начинающийся «Единица расчёта — строка «запись × услуга»…», заменить фразу `fixed_per_visit` оплаты врача считается ОДИН раз на запись (делится между её услугами, `calc.js`); `pay-rules.doctorPay` сам добавляет полный фикс за вызов — напрямую его звать нельзя (сверка оплаты строится по строкам calc).` на:

```
`fixed_per_visit` линии схемы считается ОДИН раз на запись (делится между её услугами, попавшими под ту же линию, `calc.js`); `pay-rules.doctorPay` сам добавляет полный фикс за вызов — напрямую его звать нельзя (сверка оплаты строится по строкам calc).
- Оплата врача — СХЕМЫ (с 19.10.2026, спека `docs/superpowers/specs/2026-10-19-economics-pay-schemes-design.md`): `pay_schemes` (линии в JSONB: `percent`, `base` gross|net_of_materials, `payroll_multiplier` null = множитель салона, `fixed_per_visit`, `categories[]`, `services[]`) + `pay_scheme_assignments` (сотрудник → схема на период, периоды одного сотрудника не пересекаются — проверяет код, не БД). `pay-rules.resolvePay(ctx.pay, …)`: назначение на дату визита (позднейшее `valid_from`) → линия по приоритету услуга > категория > линия без целей («остальные услуги», не больше одной) → null = `no_pay_rule`. Услуга и категория не могут стоять в двух линиях (400 с номерами линий, `schemeLineConflicts`). Удаление назначенной схемы — 409 (ON DELETE RESTRICT), не каскад. Старая `staff_pay_rules` в БД осталась, кодом не читается; ручек `/pay-rules` нет. Фронт: `ecoParseSchemeForm`/`ecoSchemeConflicts` — зеркало серверной валидации, редактор держит черновик в `_eco.schemeDraft` и перерисовывает целиком только на добавление/удаление линии (иначе теряется фокус в полях).
```

- [ ] **Step 4: Чек-лист приёмки** `docs/2026-10-19-economics-acceptance.md`, п. 4 заменить на:

```
4. Схемы оплаты: создать схему (несколько категорий с одним процентом, отдельная услуга из этих категорий со своим процентом и базой «минус материалы», линия «остальные услуги»), назначить врачу — колонка «Врач» в «Услугах» стала ненулевой; у услуги, названной в линии прямо, процент её линии, а не категории; снятие назначения обнуляет оплату; удалить назначенную схему нельзя (сообщение).
```

Спека `2026-10-18-procedure-economics-design.md`, §3.3 — первой строкой добавить: `> Заменён схемами оплаты: см. `2026-10-19-economics-pay-schemes-design.md`.`

- [ ] **Step 5: Полный прогон тестов экономики и фронта**

Run: `cd /root/loyalpro/backend && npx jest economics 2>&1 | tail -6 && cd /root/loyalpro && node --test frontend/js/pages/economics-table.test.js 2>&1 | tail -4`
Expected: все PASS.

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add CLAUDE.md docs/2026-10-19-economics-acceptance.md docs/superpowers/specs/2026-10-18-procedure-economics-design.md && git commit -m "docs(economics): схемы оплаты труда в CLAUDE.md и чек-листе приёмки

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Самопроверка плана по спеке

- §2 модель данных → Task 1 (таблицы), Task 5 (инварианты схемы и назначений), Task 4 (CRUD).
- §3 резолв и формула → Task 2 (`resolvePay`, `doctorPay`), Task 3 (calc: ключ фикса `${schemeId}:${lineIdx}`, поля `pay_scheme_id`/`pay_line_idx`, `report.js`).
- §4 API → Task 5 (все 7 ручек, 409, пересечения, `report.invalidate`).
- §5 фронт → Task 6 (помощники), Task 7 (три блока, пикер, «без схемы», CSS, `?v=`).
- §6 тесты → в каждой задаче; живая проверка → Task 7 Step 5 и Task 8 Step 2.
- §7 перенос данных → Task 8 Step 1 (две схемы, два назначения).
- Имена сквозные: `resolvePay`, `schemeLineConflicts`, `conflictText`, `assignmentsOverlap`, `isFallbackLine` (Task 2) используются в Task 3 и 5; `listPaySchemes`/`listPayAssignments`/`paySchemeExists`/`insertPayScheme`/`updatePayScheme`/`deletePayScheme`/`insertPayAssignment`/`updatePayAssignment`/`deletePayAssignment` (Task 4) — в Task 5 и моке теста; `ecoParseSchemeForm`/`ecoSchemeConflicts`/`ecoSchemeConflictText`/`ecoLineText`/`ecoLineIsFallback`/`ecoPlural`/`ecoParseAssignmentForm`/`ecoAssignmentsOverlap`/`ecoStaffWithoutScheme` (Task 6) — в Task 7.
