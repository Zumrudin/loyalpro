# Goal Pace Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Автокомментарий темпа в карточке «Цель месяца» дашборда специалиста: укладывается/впритык/не укладывается + «нужно ₽X за смену» по графику работы.

**Architecture:** Чистая функция `computePace` в `services/staff-goals.js` (TDD, jest), результат в `goal.services.pace`/`goal.goods.pace` из `getGoalForStaff`, фронт рендерит фразы по `pace.status`. Спека: `docs/superpowers/specs/2026-06-12-goal-pace-analysis-design.md`.

**Tech Stack:** Node/Express, jest (`npx jest staff-goals.test.js`), vanilla JS frontend.

**Окружение:** работа в `main` (фича маленькая, прошлый воркфлоу с веткой по желанию — допустимо прямо в main с атомарными коммитами). Dev PM2 `loyalpro` :3001; PATH для node/pm2: `export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"`.

---

### Task 1: TDD — computePace

**Files:**
- Test: `backend/staff-goals.test.js` (дописать describe в конец)
- Modify: `backend/services/staff-goals.js` (новая функция + экспорт)

- [ ] **Step 1.1: Написать падающие тесты**

В конец `backend/staff-goals.test.js` добавить:

```js
describe('computePace', () => {
  const { computePace } = require('./services/staff-goals');

  test('план не задан → null', () => {
    expect(computePace(0, 100, 200, 5, 20)).toBeNull();
  });
  test('факт ровно план → done, overPct 0', () => {
    expect(computePace(100000, 100000, 120000, 10, 20))
      .toEqual({ status: 'done', overPct: 0 });
  });
  test('перевыполнение → done с overPct', () => {
    expect(computePace(100000, 112000, 130000, 10, 20))
      .toEqual({ status: 'done', overPct: 12 });
  });
  test('нет графика → no_schedule с ratio', () => {
    const p = computePace(100000, 40000, 80000, 0, 0);
    expect(p.status).toBe('no_schedule');
    expect(p.ratio).toBeCloseTo(0.8);
  });
  test('прогноз ровно 105% → ahead', () => {
    expect(computePace(100000, 50000, 105000, 10, 20).status).toBe('ahead');
  });
  test('прогноз ровно 95% → tight', () => {
    const p = computePace(100000, 50000, 95000, 10, 20);
    expect(p.status).toBe('tight');
    expect(p.remainingShifts).toBe(10);
    expect(p.perShiftNeeded).toBe(5000); // (100000-50000)/10
  });
  test('прогноз 94.9% → behind', () => {
    expect(computePace(100000, 40000, 94900, 10, 20).status).toBe('behind');
  });
  test('perShiftNeeded округляется вверх', () => {
    const p = computePace(100000, 40000, 80000, 13, 20); // осталось 7 смен, нужно 60000/7
    expect(p.perShiftNeeded).toBe(Math.ceil(60000 / 7)); // 8572
  });
  test('смен не осталось при behind → perShiftNeeded null', () => {
    const p = computePace(100000, 40000, 80000, 20, 20);
    expect(p.status).toBe('behind');
    expect(p.remainingShifts).toBe(0);
    expect(p.perShiftNeeded).toBeNull();
  });
});
```

- [ ] **Step 1.2: Запустить — убедиться что падают**

```bash
cd /root/loyalpro/backend && export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
npx jest staff-goals.test.js 2>&1 | tail -5
```

Expected: FAIL, `computePace is not a function`.

- [ ] **Step 1.3: Реализация**

В `backend/services/staff-goals.js` после `forecastMonthEnd` добавить:

```js
// Оценка темпа выполнения плана для автокомментария на дашборде.
// Спека: docs/superpowers/specs/2026-06-12-goal-pace-analysis-design.md
// → null            план не задан
// → {status:'done', overPct}                 факт ≥ плана
// → {status:'no_schedule', ratio}            график не синхронизирован
// → {status:'ahead'}                          прогноз ≥ 105% плана
// → {status:'tight'|'behind', perShiftNeeded, remainingShifts}
//   tight: 95–105%, behind: <95%. perShiftNeeded=null если смен не осталось.
function computePace(target, fact, forecast, workedDays, plannedDays) {
  const t = parseFloat(target) || 0;
  if (t <= 0) return null;
  const f = parseFloat(fact) || 0;
  if (f >= t) return { status: 'done', overPct: Math.round((f / t - 1) * 100) };
  const ratio = (parseFloat(forecast) || 0) / t;
  if (!(plannedDays > 0)) return { status: 'no_schedule', ratio };
  if (ratio >= 1.05) return { status: 'ahead' };
  const remainingShifts = Math.max(0, plannedDays - workedDays);
  const perShiftNeeded = remainingShifts > 0 ? Math.ceil((t - f) / remainingShifts) : null;
  return { status: ratio >= 0.95 ? 'tight' : 'behind', perShiftNeeded, remainingShifts };
}
```

И добавить `computePace` в `module.exports`.

- [ ] **Step 1.4: Тесты зелёные**

```bash
npx jest staff-goals.test.js 2>&1 | tail -5
```

Expected: все тесты PASS (15 старых + 9 новых = 24).

- [ ] **Step 1.5: Commit**

```bash
git add backend/staff-goals.test.js backend/services/staff-goals.js
git commit -m "feat(staff-goals): computePace — оценка темпа плана с ₽/смену по графику (TDD)"
```

---

### Task 2: pace в ответе getGoalForStaff

**Files:**
- Modify: `backend/services/staff-goals.js` — функция `getGoalForStaff`, блок `return {...}`

- [ ] **Step 2.1: Вшить pace в ответ**

В `getGoalForStaff` заменить return:

```js
  return {
    month, daysTotal, elapsedDays: elapsed,
    workedDays: sc.worked, plannedDays: sc.planned,
    services: { target: servicesTarget, fact: f.services,
                forecast: forecastMonthEnd(f.services, sc.worked, sc.planned, elapsed, daysTotal) },
    goods:    { target: goodsTarget, fact: f.goods,
                forecast: forecastMonthEnd(f.goods, sc.worked, sc.planned, elapsed, daysTotal) },
  };
```

на:

```js
  const servicesForecast = forecastMonthEnd(f.services, sc.worked, sc.planned, elapsed, daysTotal);
  const goodsForecast    = forecastMonthEnd(f.goods,    sc.worked, sc.planned, elapsed, daysTotal);
  return {
    month, daysTotal, elapsedDays: elapsed,
    workedDays: sc.worked, plannedDays: sc.planned,
    services: { target: servicesTarget, fact: f.services, forecast: servicesForecast,
                pace: computePace(servicesTarget, f.services, servicesForecast, sc.worked, sc.planned) },
    goods:    { target: goodsTarget, fact: f.goods, forecast: goodsForecast,
                pace: computePace(goodsTarget, f.goods, goodsForecast, sc.worked, sc.planned) },
  };
```

- [ ] **Step 2.2: Рестарт dev + API-смок**

```bash
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
pm2 restart loyalpro && sleep 2
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login -H 'Content-Type: application/json' -d '{"email":"smoke-linked@test.local","password":"Smoke123!"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -s "http://localhost:3001/api/analytics/staff-dashboard?from=2026-06-01&to=2026-06-12" -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys,json
g=json.load(sys.stdin).get('goal') or {}
print('services.pace:', g.get('services',{}).get('pace'))
print('goods.pace:', g.get('goods',{}).get('pace'))
"
```

Expected: оба pace — объекты со status (или null если план не задан; если goal вообще null — задать план мастеру через UI/SQL и повторить).

- [ ] **Step 2.3: Все тесты не сломаны + commit**

```bash
npx jest staff-goals.test.js 2>&1 | tail -3
git add backend/services/staff-goals.js
git commit -m "feat(staff-goals): pace в goal.services/goods ответа getGoalForStaff"
```

---

### Task 3: Frontend — комментарий в goalBar

**Files:**
- Modify: `frontend/js/pages/staff-dashboard.js` — IIFE `goalHtml`, внутренняя функция `goalBar`

- [ ] **Step 3.1: Заменить goalBar**

Найти в `_sdRender()` блок:

```js
    const goalBar = (lbl, o) => {
      if (!(parseFloat(o.target) > 0)) return '';
      const pct = Math.round(o.fact / o.target * 100);
      const fc  = Math.round(o.forecast / o.target * 100);
      const color = fc >= 100 ? '#13a05e' : fc >= 80 ? '#e8a23d' : '#d23f3f';
      const fcTxt = fc >= 100
        ? `Прогноз: ₽ ${_sdFmtRub(o.forecast)} — план будет выполнен ✓`
        : `Прогноз: ₽ ${_sdFmtRub(o.forecast)} (${fc}% плана)`;
```

Заменить целиком функцию `goalBar` на:

```js
    // Цвет и комментарий — из pace (бэкенд computePace, спека 2026-06-12).
    const PACE_COLORS = { done: '#13a05e', ahead: '#13a05e', tight: '#e8a23d', behind: '#d23f3f' };
    const paceLine = (p) => {
      if (!p) return '';
      const shifts = (n) => `ещё ${n} ${_sdPlural(n, 'смена', 'смены', 'смен')}`;
      const perShift = (pp) => pp.perShiftNeeded == null ? ''
        : `: нужно в среднем ₽ ${_sdFmtRub(pp.perShiftNeeded)} за смену (${shifts(pp.remainingShifts)})`;
      if (p.status === 'done')
        return `<div style="font-size:12px;font-weight:600;color:${PACE_COLORS.done};margin-top:4px">🎉 План выполнен — перевыполнение на ${p.overPct}%! Красавчик, так держать!</div>`;
      if (p.status === 'ahead')
        return `<div style="font-size:12px;font-weight:600;color:${PACE_COLORS.ahead};margin-top:4px">🟢 Отличный темп! В таком ритме вы укладываетесь в план</div>`;
      if (p.status === 'tight')
        return `<div style="font-size:12px;font-weight:600;color:${PACE_COLORS.tight};margin-top:4px">🟡 Идёте впритык${p.perShiftNeeded == null ? '' : `: надёжнее держать в среднем ₽ ${_sdFmtRub(p.perShiftNeeded)} за смену (${shifts(p.remainingShifts)})`}</div>`;
      if (p.status === 'behind')
        return `<div style="font-size:12px;font-weight:600;color:${PACE_COLORS.behind};margin-top:4px">🔴 Таким темпом план не закрыть${perShift(p)}</div>`;
      if (p.status === 'no_schedule') {
        const r = p.ratio || 0;
        const verdict = r >= 1.05
          ? `<span style="color:${PACE_COLORS.ahead}">🟢 По текущему темпу вы укладываетесь в план</span>`
          : r >= 0.95
            ? `<span style="color:${PACE_COLORS.tight}">🟡 По текущему темпу идёте впритык</span>`
            : `<span style="color:${PACE_COLORS.behind}">🔴 По текущему темпу план не закрывается</span>`;
        return `<div style="font-size:12px;font-weight:600;margin-top:4px">${verdict}</div>
          <div style="font-size:11px;color:var(--t3);margin-top:2px">Синхронизируйте график в YClients, чтобы видеть расчёт по сменам</div>`;
      }
      return '';
    };
    const paceColor = (p, fcPct) => {
      if (p && PACE_COLORS[p.status]) return PACE_COLORS[p.status];
      if (p && p.status === 'no_schedule')
        return p.ratio >= 1.05 ? PACE_COLORS.ahead : p.ratio >= 0.95 ? PACE_COLORS.tight : PACE_COLORS.behind;
      return fcPct >= 100 ? '#13a05e' : fcPct >= 80 ? '#e8a23d' : '#d23f3f'; // фолбэк до деплоя бэка
    };
    const goalBar = (lbl, o) => {
      if (!(parseFloat(o.target) > 0)) return '';
      const pct = Math.round(o.fact / o.target * 100);
      const fc  = Math.round(o.forecast / o.target * 100);
      const color = paceColor(o.pace, fc);
      return `
        <div style="margin-top:12px">
          <div style="display:flex;justify-content:space-between;gap:8px;font-size:13px;margin-bottom:4px;flex-wrap:wrap">
            <span><b>${lbl}</b>: ₽ ${_sdFmtRub(o.fact)} <span style="color:var(--t3)">из ₽ ${_sdFmtRub(o.target)}</span></span>
            <b style="color:${color}">${Math.min(999, pct)}%</b>
          </div>
          <div style="height:10px;background:var(--bg);border-radius:5px;overflow:hidden">
            <div style="height:100%;width:${Math.min(100, pct)}%;background:${color};border-radius:5px"></div>
          </div>
          <div style="font-size:11px;color:var(--t3);margin-top:4px">Прогноз: ₽ ${_sdFmtRub(o.forecast)} (${fc}% плана)</div>
          ${paceLine(o.pace)}
        </div>`;
    };
```

ВАЖНО: старые переменные `fcTxt` и строка `<div style="font-size:12px;color:${color};...">${fcTxt}</div>` удаляются — прогноз теперь серой строкой 11px + отдельный pace-комментарий.

- [ ] **Step 3.2: Sanity + commit**

```bash
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
node --check frontend/js/pages/staff-dashboard.js
git add frontend/js/pages/staff-dashboard.js
git commit -m "feat(staff-dashboard): автокомментарий темпа в «Цели месяца» — вердикт + ₽/смену"
```

---

### Task 4: Браузерная приёмка + deploy (контроллер)

- [ ] Step 4.1: Playwright на dev: залогиниться smoke-linked, проверить карточку цели — комментарии под обоими барами, цвета бара = цвета комментария. Подменить план через SQL для проверки всех 5 статусов (done/ahead/tight/behind/no_schedule) и вернуть как было.
- [ ] Step 4.2: `git push origin main`; прод: `ssh root@217.114.0.254 "cd /root/loyalpro_new && git pull origin main && pm2 restart loyalpro"`.
- [ ] Step 4.3: Прод-смок (testtest@mail.ru / Admin123) — скриншот карточки цели пользователю.
