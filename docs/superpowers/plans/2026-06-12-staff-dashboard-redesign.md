# Staff Dashboard Pastel Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Превратить серый дашборд специалиста в дружелюбный пастельный UI с hero-блоком, count-up цифрами, прогресс-кольцами, SVG-графиком и сортируемым топ-5 — без изменения данных и с сохранением всех существующих фич (бейджи ▲/▼, цель месяца, сплэш-приветствие).

**Architecture:** Только фронт (`staff-dashboard.js` + `features.css`) плюс одно поле `staffAvatar` в backend-ответе. SVG вместо canvas для графика. Ноль зависимостей. Спека: `docs/superpowers/specs/2026-06-12-staff-dashboard-redesign-design.md` — прочитай её целиком перед началом.

**Tech Stack:** Vanilla JS, SVG, CSS animations, Express/pg (1 строка SQL).

**Контекст веток:** работа ведётся в ветке `feature/sd-pastel-redesign` от `main`. Текущая ветка `feature/salon-logo-favicon` содержит чужую незакоммиченную работу — НЕ трогать её файлы (`backend/config.js`, `backend/migrations.js`, `backend/routes/salon.js`, `frontend/index.html`, `frontend/js/app.js`, `frontend/js/core/utils.js`, `frontend/js/pages/settings.js`).

**Dev-сервер:** PM2 `loyalpro` на :3001, фронт раздаётся статикой — правки JS/CSS видны после перезагрузки страницы (БЕЗ рестарта PM2). Рестарт нужен только для backend-правки Task 1. UI проверять только через MCP Playwright (`mcp__playwright__*`), БД — через `mcp__postgres__query`.

---

### Task 0: Ветка

- [ ] **Step 0.1: Создать ветку от main**

```bash
cd /root/loyalpro && git stash list   # убедиться что мы ничего не теряем
git checkout main && git pull origin main
git checkout -b feature/sd-pastel-redesign
# Перенести коммит спеки с чужой ветки:
git cherry-pick b8c45f3
```

Expected: ветка `feature/sd-pastel-redesign`, спека на месте (`docs/superpowers/specs/2026-06-12-staff-dashboard-redesign-design.md`).

---

### Task 1: Backend — поле `staffAvatar`

**Files:**
- Modify: `backend/routes/api.js` (запрос link в `GET /analytics/staff-dashboard`, ~строка 336)

- [ ] **Step 1.1: Добавить avatar_url в запрос привязки**

В `backend/routes/api.js` найти запрос (внутри `router.get('/analytics/staff-dashboard', ...)`):

```js
    const link = await db.oneOrNone(`
      SELECT sm.id AS staff_member_id, sm.yclients_staff_id, sm.name AS staff_name
      FROM users u JOIN staff_members sm ON sm.id = u.staff_member_id
      WHERE u.id = $1 AND sm.salon_id = $2
    `, [uid, sid]);
```

Заменить SELECT-строку на:

```js
      SELECT sm.id AS staff_member_id, sm.yclients_staff_id, sm.name AS staff_name, sm.avatar_url
```

- [ ] **Step 1.2: Добавить staffAvatar в ответ**

Ниже в том же роуте найти место, где собирается `stats` для ответа (поиск по `staffName`). Там есть присвоение вида `stats.staffName = link.staff_name`. Рядом добавить:

```js
    stats.staffAvatar = link.avatar_url || null;
```

(Если `staffName` кладётся иначе — например в объект-литерале ответа — добавить `staffAvatar: link.avatar_url || null` тем же способом рядом.)

- [ ] **Step 1.3: Рестарт dev + smoke**

```bash
pm2 restart loyalpro
```

Затем получить токен специалиста и дёрнуть endpoint:

```bash
curl -s -X POST http://localhost:3001/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"<dev-specialist-email>","password":"<password>"}' | head -c 400
# взять token из ответа
curl -s "http://localhost:3001/api/analytics/staff-dashboard?from=2026-06-01&to=2026-06-12" \
  -H "Authorization: Bearer <TOKEN>" | python3 -m json.tool | grep -A1 staffAvatar
```

Какой dev-логин специалиста существует — посмотреть в БД: `SELECT email, role FROM users WHERE role='specialist'` через `mcp__postgres__query`. Expected: в `stats` есть `staffAvatar` (URL yclients или null).

- [ ] **Step 1.4: Commit**

```bash
git add backend/routes/api.js
git commit -m "feat(staff-dashboard): staffAvatar в ответе аналитики — аватар мастера для hero-блока"
```

---

### Task 2: CSS — пастельная палитра, карточки, анимации

**Files:**
- Modify: `frontend/css/features.css` (дописать блок в конец; существующие `.sd-*` правила со строк 210–248 НЕ удалять)

- [ ] **Step 2.1: Дописать CSS-блок**

В конец `features.css` добавить (целиком):

```css
/* ─── STAFF DASHBOARD PASTEL REDESIGN ─────────────────────────── */
/* Палитра: --sdp-* фон, --sda-* акцент. Спека 2026-06-12. */
:root{
  --sdp-rev:#e6f7f1;   --sda-rev:#0fa97e;
  --sdp-vis:#e8f1fd;   --sda-vis:#3b82f6;
  --sdp-nosh:#fdf0e6;  --sda-nosh:#e8833a;
  --sdp-avg:#f0ecfd;   --sda-avg:#7c5cf0;
  --sdp-new:#fdecf2;   --sda-new:#e0508a;
  --sdp-ret:#e4f6f8;   --sda-ret:#0ea5b7;
  --sdp-reap:#eff8e6;  --sda-reap:#6aa832;
  --sdp-goods:#fdf4e2; --sda-goods:#d99114;
  --sdp-util:#f5ebfa;  --sda-util:#a855d8;
}
[data-theme="dark"]{
  --sdp-rev:#11261f;   --sda-rev:#2dd4a8;
  --sdp-vis:#13202f;   --sda-vis:#60a5fa;
  --sdp-nosh:#2a1d12;  --sda-nosh:#f0995a;
  --sdp-avg:#1d1830;   --sda-avg:#a78bfa;
  --sdp-new:#2a1520;   --sda-new:#f077a8;
  --sdp-ret:#10262a;   --sda-ret:#38c5d8;
  --sdp-reap:#1a2412;  --sda-reap:#8fc758;
  --sdp-goods:#27200f; --sda-goods:#eab94a;
  --sdp-util:#231630;  --sda-util:#c084ec;
}

/* Пастельная карточка: фон по метрике, без рамки, скругление 16 */
.sd-p{border:none!important;border-radius:16px!important;
  background:var(--sdp,var(--card));
  transition:transform .2s ease,box-shadow .2s ease}
.sd-p:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(0,0,0,.10)}
.sd-p .sv{color:var(--sda,var(--t1))}
.sd-p-rev  {--sdp:var(--sdp-rev);  --sda:var(--sda-rev)}
.sd-p-vis  {--sdp:var(--sdp-vis);  --sda:var(--sda-vis)}
.sd-p-nosh {--sdp:var(--sdp-nosh); --sda:var(--sda-nosh)}
.sd-p-avg  {--sdp:var(--sdp-avg);  --sda:var(--sda-avg)}
.sd-p-new  {--sdp:var(--sdp-new);  --sda:var(--sda-new)}
.sd-p-ret  {--sdp:var(--sdp-ret);  --sda:var(--sda-ret)}
.sd-p-reap {--sdp:var(--sdp-reap); --sda:var(--sda-reap)}
.sd-p-goods{--sdp:var(--sdp-goods);--sda:var(--sda-goods)}
.sd-p-util {--sdp:var(--sdp-util); --sda:var(--sda-util)}

/* Иконка метрики в белом круге */
.sd-p-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.sd-p-head .sl{margin-bottom:0}
.sd-p-ico{width:30px;height:30px;border-radius:50%;background:var(--card);
  display:inline-flex;align-items:center;justify-content:center;
  font-size:15px;box-shadow:0 1px 3px rgba(0,0,0,.08);flex-shrink:0}

/* Hero */
.sd-hero{display:flex;align-items:center;gap:14px;padding:18px 20px;
  border-radius:20px;margin-bottom:14px;
  background:linear-gradient(135deg,var(--sdp-rev) 0%,var(--sdp-avg) 100%)}
.sd-hero-ava{width:56px;height:56px;border-radius:50%;object-fit:cover;
  border:3px solid var(--card);box-shadow:0 2px 8px rgba(0,0,0,.10);flex-shrink:0}
.sd-hero-ava-fb{width:56px;height:56px;border-radius:50%;flex-shrink:0;
  border:3px solid var(--card);background:var(--sda-rev);color:#fff;
  display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700}
.sd-hero-t h2{margin:0;font-size:19px;letter-spacing:-.3px;color:var(--t1)}
.sd-hero-sub{font-size:13px;color:var(--t2);margin-top:3px}
.sd-hero-dates{margin-left:auto;font-size:12px;color:var(--t3);white-space:nowrap}

/* Сегментный контрол со скользящей пилюлей */
.sd-seg{position:relative;display:inline-flex;background:var(--bg);
  border:1px solid var(--bd);border-radius:12px;padding:3px;gap:0}
.sd-seg button{position:relative;z-index:1;border:none;background:transparent;
  padding:8px 18px;font-size:13px;font-weight:600;color:var(--t3);cursor:pointer;
  border-radius:9px;font-family:inherit;transition:color .2s}
.sd-seg button.on{color:var(--t1)}
.sd-seg-pill{position:absolute;top:3px;bottom:3px;border-radius:9px;
  background:var(--card);box-shadow:0 1px 4px rgba(0,0,0,.12);
  transition:left .25s cubic-bezier(.4,0,.2,1),width .25s cubic-bezier(.4,0,.2,1)}

/* Каскад появления */
.sd-anim{animation:sdCardIn .5s ease both;animation-delay:calc(var(--i,0)*60ms)}
@keyframes sdCardIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}

/* Прогресс-кольцо */
.sd-ring-row{display:flex;align-items:center;gap:12px;margin-top:4px}
.sd-ring{width:64px;height:64px;flex-shrink:0}
.sd-ring .bgc{fill:none;stroke:var(--card);stroke-width:7}
.sd-ring .fgc{fill:none;stroke:var(--sda,var(--a));stroke-width:7;stroke-linecap:round;
  transform:rotate(-90deg);transform-origin:50% 50%;
  transition:stroke-dashoffset .7s cubic-bezier(.3,.6,.3,1)}
.sd-ring text{font-size:15px;font-weight:800;fill:var(--sda,var(--t1))}

/* Мини-бары в разбивке выручки */
.sd-mini{height:4px;border-radius:2px;background:rgba(0,0,0,.06);overflow:hidden;margin-top:2px}
[data-theme="dark"] .sd-mini{background:rgba(255,255,255,.08)}
.sd-mini i{display:block;height:100%;border-radius:2px;width:0;transition:width .7s ease .2s}

/* SVG-график */
.sd-chart-wrap{position:relative;margin-top:10px}
.sd-chart-wrap svg{display:block;width:100%}
.sd-chart-line{fill:none;stroke:var(--sda-rev);stroke-width:2.5;
  stroke-linecap:round;stroke-linejoin:round}
.sd-chart-dot{fill:var(--sda-rev);stroke:var(--card);stroke-width:2;opacity:0;transition:opacity .15s}
.sd-chart-guide{stroke:var(--t3);stroke-width:1;stroke-dasharray:3 4;opacity:0;transition:opacity .15s}
.sd-chart-x{font-size:10px;fill:var(--t3)}
.sd-tip{position:absolute;pointer-events:none;background:var(--t1);color:var(--card);
  font-size:12px;font-weight:600;padding:5px 9px;border-radius:8px;white-space:nowrap;
  transform:translate(-50%,-130%);opacity:0;transition:opacity .15s;z-index:5}

/* Топ-5 */
.sd-t5-row{display:grid;grid-template-columns:26px 1fr 64px 90px;gap:8px;
  align-items:center;padding:9px 4px;border-bottom:1px solid var(--bg);font-size:13px}
.sd-t5-rank{font-weight:800;color:var(--t3);text-align:center}
.sd-t5-name{min-width:0}
.sd-t5-name span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-t5-bar{height:6px;border-radius:3px;background:var(--bg);overflow:hidden;margin-top:5px}
.sd-t5-bar i{display:block;height:100%;border-radius:3px;background:var(--sdp-rev);width:0;transition:width .7s ease .15s}
.sd-t5-row.lead .sd-t5-bar i{background:var(--sda-rev)}
.sd-t5-cnt{text-align:right;color:var(--t2)}
.sd-t5-sum{text-align:right;font-weight:700}
.sd-t5-h{display:grid;grid-template-columns:26px 1fr 64px 90px;gap:8px;padding:4px;
  font-size:11px;color:var(--t3);font-weight:600;border-bottom:1px solid var(--bd)}
.sd-t5-h .srt{cursor:pointer;text-align:right;user-select:none}
.sd-t5-h .srt:hover{color:var(--t1)}

/* Десктоп: карточка выручки занимает 2 из 3 колонок ряда 1 */
@media(min-width:701px){.sd-g3 .sd-card-rev{grid-column:span 2}}

/* Доступность: всё статично при reduced-motion */
@media (prefers-reduced-motion: reduce){
  .sd-anim{animation:none}
  .sd-ring .fgc,.sd-mini i,.sd-t5-bar i,.sd-seg-pill,.sd-p{transition:none}
}
@media(max-width:700px){
  .sd-hero{flex-wrap:wrap;padding:14px 16px}
  .sd-hero-dates{margin-left:0;flex-basis:100%}
  .sd-hero-t h2{font-size:17px}
}
```

- [ ] **Step 2.2: Commit**

```bash
git add frontend/css/features.css
git commit -m "feat(staff-dashboard): CSS пастельной палитры, hero, колец, SVG-чарта, топ-5"
```

---

### Task 3: JS — хелперы (count-up, кольцо, hero, сегментный контрол)

**Files:**
- Modify: `frontend/js/pages/staff-dashboard.js` — добавить функции ПЕРЕД `async function loadStaffDashboard()`

- [ ] **Step 3.1: Добавить хелперы**

```js
// ── Редизайн: пастельные хелперы (спека 2026-06-12) ─────────────
// Count-up: после вставки HTML вызвать _sdRunCountUps(root).
// Элемент: <span class="sd-cu" data-cu="58600" data-fmt="rub|int|pct1"></span>
function _sdCuFmt(v, fmt) {
  if (fmt === 'rub')  return '₽ ' + Math.round(v).toLocaleString('ru');
  if (fmt === 'pct1') return (Math.round(v * 10) / 10) + '%';
  return String(Math.round(v));
}
function _sdRunCountUps(root) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.querySelectorAll('.sd-cu').forEach(el => {
    const target = parseFloat(el.dataset.cu) || 0;
    const fmt = el.dataset.fmt || 'int';
    if (reduced || target === 0) { el.textContent = _sdCuFmt(target, fmt); return; }
    const t0 = performance.now(), dur = 600;
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
      el.textContent = _sdCuFmt(target * e, fmt);
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// Прогресс-кольцо 64px. val: 0..100 или null («—», пустое кольцо).
// Заполнение анимируется CSS-транзишеном stroke-dashoffset — после вставки
// в DOM вызвать _sdFillRings(root).
const _SD_RING_C = 2 * Math.PI * 26; // r=26 во viewBox 64
function _sdRingHtml(val) {
  const shown = val == null ? '—' : (val + '%');
  return `
    <svg class="sd-ring" viewBox="0 0 64 64" data-ring="${val == null ? '' : val}">
      <circle class="bgc" cx="32" cy="32" r="26"/>
      <circle class="fgc" cx="32" cy="32" r="26"
        stroke-dasharray="${_SD_RING_C.toFixed(1)}"
        stroke-dashoffset="${_SD_RING_C.toFixed(1)}"/>
      <text x="32" y="37" text-anchor="middle">${shown}</text>
    </svg>`;
}
function _sdFillRings(root) {
  // Двойной rAF — иначе браузер схлопнет транзишен (как в _sdRender прогресс-бар)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.querySelectorAll('.sd-ring').forEach(svg => {
      const v = parseFloat(svg.dataset.ring);
      if (!isFinite(v)) return;
      const off = _SD_RING_C * (1 - Math.min(100, Math.max(0, v)) / 100);
      svg.querySelector('.fgc').style.strokeDashoffset = off.toFixed(1);
    });
  }));
}

// Hero-блок. s — data.stats. Использует существующий _sdGreeting().
function _sdHeroHtml(s) {
  const [greet, emoji] = _sdGreeting();
  const name = String(s.staffName || '').trim().split(/\s+/).pop() || ''; // «Гатауллина Юлия» → «Юлия»
  const ava = s.staffAvatar
    ? `<img class="sd-hero-ava" src="${_sdEsc(s.staffAvatar)}" alt="" onerror="this.outerHTML='<div class=&quot;sd-hero-ava-fb&quot;>${_sdEsc(name.slice(0,1))}</div>'">`
    : `<div class="sd-hero-ava-fb">${_sdEsc(name.slice(0, 1) || '•')}</div>`;
  return `
    <div class="sd-hero sd-anim" style="--i:0">
      ${ava}
      <div class="sd-hero-t">
        <h2>${greet}${name ? ', ' + _sdEsc(name) : ''}! ${emoji}</h2>
        <div class="sd-hero-sub">За период: ${s.periodRecords} ${_sdPlural(s.periodRecords, 'визит', 'визита', 'визитов')} на ₽ ${_sdFmtRub(s.periodRevenue)}</div>
      </div>
      <div class="sd-hero-dates">${_sdState.from} … ${_sdState.to}</div>
    </div>`;
}
function _sdPlural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// Сегментный контрол: позиционируем пилюлю под активной кнопкой.
function _sdMovePill(seg) {
  const pill = seg.querySelector('.sd-seg-pill');
  const btn = seg.querySelector('button.on');
  if (!pill || !btn) return;
  pill.style.left = btn.offsetLeft + 'px';
  pill.style.width = btn.offsetWidth + 'px';
}
```

- [ ] **Step 3.2: Sanity-check синтаксиса**

```bash
node --check frontend/js/pages/staff-dashboard.js
```

Expected: без ошибок.

- [ ] **Step 3.3: Commit**

```bash
git add frontend/js/pages/staff-dashboard.js
git commit -m "feat(staff-dashboard): хелперы редизайна — count-up, кольца, hero, сегментный контрол"
```

---

### Task 4: JS — новый рендер карточек (hero + ряды 1–2), сохранение бейджей и цели

**Files:**
- Modify: `frontend/js/pages/staff-dashboard.js` — внутри `_sdRender()` заменить блок `root.innerHTML = ...` (от `<div class="sd-toolbar">` до закрытия топ-5) и пострендер-хвост

**НЕ трогать:** всё до `root.innerHTML` (сплэш, `_sdC`, `cRev…cGoods`, `goalHtml`) — это сохраняемая логика.

- [ ] **Step 4.1: Заменить разметку toolbar → сегментный контрол + hero**

Вместо текущего `<div class="sd-toolbar">…</div>` и далее, собрать `root.innerHTML` так (полная замена шаблона; бейджи/refs из `_sdC` остаются на местах):

```js
  const presets = { today: 'Сегодня', week: 'Неделя', month: 'Месяц' };
  root.innerHTML = `
    ${_sdHeroHtml(s)}
    <div class="sd-toolbar">
      <div class="sd-seg" id="sd-seg">
        <div class="sd-seg-pill"></div>
        ${Object.entries(presets).map(([p, t]) =>
          `<button class="${p === _sdState.preset ? 'on' : ''}" data-preset="${p}">${t}</button>`).join('')}
      </div>
    </div>
    ${goalHtml}
    <div class="sd-g3" style="margin-top:${goalHtml ? '14px' : '0'}">
      <div class="sc sd-p sd-p-rev sd-anim sd-card-rev" style="--i:1">
        <div class="sd-p-head"><span class="sd-p-ico">₽</span><span class="sl">Моя выручка за период</span></div>
        <div class="sv"><span class="sd-cu" data-cu="${parseFloat(s.periodRevenue) || 0}" data-fmt="rub"></span> ${cRev.badge}</div>${cRev.sub}
        <div style="margin-top:10px;border-top:1px solid rgba(0,0,0,.07);padding-top:10px;font-size:13px;line-height:1.6">
          ${[['Услуги', r.services, 'var(--sda-rev)'], ['Косметика', r.goods, 'var(--sda-goods)'], ['Абонементы', r.abonement, 'var(--sda-avg)']].map(([lbl, v, col]) => {
            const pct = s.periodRevenue > 0 ? Math.round((parseFloat(v) || 0) / s.periodRevenue * 100) : 0;
            return `<div style="margin-bottom:6px">
              <div style="display:flex;justify-content:space-between">
                <span style="color:var(--t3)"><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${col};margin-right:6px"></i>${lbl}</span>
                <b>₽ ${_sdFmtRub(v)}</b>
              </div>
              <div class="sd-mini"><i data-w="${pct}" style="background:${col}"></i></div>
            </div>`;
          }).join('')}
        </div>
        ${cRev.ref}
      </div>
      <div class="sc sd-p sd-p-vis sd-anim" style="--i:2">
        <div class="sd-p-head"><span class="sd-p-ico">📅</span><span class="sl">Визитов проведено</span></div>
        <div class="sv"><span class="sd-cu" data-cu="${s.periodRecords}" data-fmt="int"></span> ${cVis.badge}</div>${cVis.sub}${cVis.ref}
      </div>
      <div class="sc sd-p sd-p-nosh sd-anim" style="--i:3">
        <div class="sd-p-head"><span class="sd-p-ico">✖️</span><span class="sl">Не пришли</span></div>
        <div class="sv"><span class="sd-cu" data-cu="${s.noShowClients}" data-fmt="int"></span> ${cNoSh.badge}</div>${cNoSh.sub}${cNoSh.ref}
      </div>
      <div class="sc sd-p sd-p-avg sd-anim" style="--i:4">
        <div class="sd-p-head"><span class="sd-p-ico">💳</span><span class="sl">Средний чек</span></div>
        <div class="sv"><span class="sd-cu" data-cu="${parseFloat(s.avgCheck) || 0}" data-fmt="rub"></span> ${cAvg.badge}</div>${cAvg.sub}${cAvg.ref}
      </div>
      <div class="sc sd-p sd-p-new sd-anim" style="--i:5">
        <div class="sd-p-head"><span class="sd-p-ico">🌱</span><span class="sl">Первичных за период</span></div>
        <div class="sv"><span class="sd-cu" data-cu="${s.newClients}" data-fmt="int"></span> ${cNew.badge}</div>${cNew.sub}${cNew.ref}
      </div>
    </div>

    <div class="sd-g4" style="margin-top:14px">
      <div class="sc sd-p sd-p-ret sd-anim" style="--i:6">
        <div class="sd-p-head"><span class="sd-p-ico">🔄</span><span class="sl">Возвращаемость</span></div>
        <div class="sd-ring-row">
          ${_sdRingHtml(s.retentionRate)}
          <div>
            ${cRet.badge ? `<div>${cRet.badge}</div>` : ''}${cRet.sub}
            <div class="sd" style="font-size:11px;color:var(--t3)">клиенты, вернувшиеся в течение 45 дней</div>
          </div>
        </div>
        ${cRet.ref}
      </div>
      <div class="sc sd-p sd-p-reap sd-anim" style="--i:7">
        <div class="sd-p-head"><span class="sd-p-ico">📝</span><span class="sl">Перезапись</span></div>
        <div class="sd-ring-row">
          ${_sdRingHtml(s.reappointmentRate)}
          <div>
            ${cReap.badge ? `<div>${cReap.badge}</div>` : ''}${cReap.sub}
            <div class="sd" style="font-size:11px;color:var(--t3)">% визитов с последующей записью</div>
          </div>
        </div>
        ${cReap.ref}
      </div>
      <div class="sc sd-p sd-p-goods sd-anim" style="--i:8">
        <div class="sd-p-head"><span class="sd-p-ico">🛍️</span><span class="sl">Продажи товаров</span></div>
        <div class="sv"><span class="sd-cu" data-cu="${s.goodsCount || 0}" data-fmt="int"></span> <span style="font-size:14px;color:var(--t3);font-weight:400">шт</span> ${cGoods.badge}</div>${cGoods.sub}
        <div class="sd" style="font-size:11px;color:var(--t3);margin-top:6px">на ₽ ${_sdFmtRub(s.goodsRevenue)}</div>
        ${cGoods.ref}
      </div>
      <div class="sc sd-p sd-p-util sd-anim" style="--i:9">
        <div class="sd-p-head"><span class="sd-p-ico">⏱️</span><span class="sl">Загрузка</span></div>
        <div class="sd-ring-row">
          ${_sdRingHtml(s.utilizationRate)}
          <div>
            ${cUtil.badge ? `<div>${cUtil.badge}</div>` : ''}${cUtil.sub}
            <div class="sd" style="font-size:11px;color:var(--t3)">от рабочего расписания</div>
          </div>
        </div>
        ${cUtil.ref}
      </div>
    </div>

    <div class="sc sd-anim" style="--i:10;margin-top:14px;border-radius:16px">
      <div class="sl">Дневной график выручки</div>
      <div class="sd-chart-wrap" id="sd-chart-wrap"></div>
    </div>

    <div class="sc sd-anim" style="--i:11;margin-top:14px;border-radius:16px">
      <div class="sl">Топ-5 услуг</div>
      <div id="sd-top5"></div>
    </div>
  `;
```

- [ ] **Step 4.2: Пострендер-хвост**

Сразу после `root.innerHTML = ...` заменить старый хвост (обработчики `[data-preset]` + canvas-вызов) на:

```js
  // Переключатель периодов
  root.querySelectorAll('[data-preset]').forEach(b => {
    b.onclick = () => { _sdSetPeriod(b.dataset.preset); _sdRender(); };
  });
  const seg = root.querySelector('#sd-seg');
  if (seg) requestAnimationFrame(() => _sdMovePill(seg));

  // Анимации
  _sdRunCountUps(root);
  _sdFillRings(root);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.querySelectorAll('.sd-mini i').forEach(i => { i.style.width = (i.dataset.w || 0) + '%'; });
  }));

  // График + топ-5 (функции из Task 5/6)
  _sdRenderChart(root.querySelector('#sd-chart-wrap'), data.dailyRevenue || []);
  _sdRenderTop5(root.querySelector('#sd-top5'), data.topServices || []);
```

Старую функцию `_sdDrawChart` (canvas) удалить целиком. Чтобы файл оставался рабочим до Task 5/6, добавить в этом же коммите временные заглушки в конец файла (Task 5 и 6 их заменят):

```js
function _sdRenderChart(wrap, rows) { /* Task 5 */ }
function _sdRenderTop5(wrap, rows)  { /* Task 6 */ }
```

- [ ] **Step 4.3: Проверка в браузере (MCP Playwright)**

Залогиниться специалистом на `http://localhost:3001`, дождаться сплэша → дашборда. Expected: hero с приветствием и аватаром/инициалом, пастельные карточки с иконками, цифры «накручиваются», кольца заполняются, бейджи ▲/▼ и «Прошлый месяц: …» на местах, карточка «Цель» на месте. График и топ-5 — пустые контейнеры (это ок до Task 5/6). Сделать скриншот.

- [ ] **Step 4.4: Commit**

```bash
node --check frontend/js/pages/staff-dashboard.js
git add frontend/js/pages/staff-dashboard.js
git commit -m "feat(staff-dashboard): пастельные карточки, hero, count-up, кольца — бейджи и цель сохранены"
```

---

### Task 5: JS — SVG-график с градиентом и тултипом

**Files:**
- Modify: `frontend/js/pages/staff-dashboard.js` — заменить заглушку `_sdRenderChart`

- [ ] **Step 5.1: Реализация**

```js
// SVG-график выручки: сглаженная кривая + градиентная область + hover-тултип.
// rows: [{d:'2026-06-05', revenue:'58600'}]. 1 точка → плашка вместо графика.
function _sdRenderChart(wrap, rows) {
  if (!wrap) return;
  if (!rows.length) {
    wrap.innerHTML = '<div class="pp-hint" style="padding:20px;text-align:center">Нет данных за период</div>';
    return;
  }
  if (rows.length === 1) {
    wrap.innerHTML = `<div style="padding:24px;text-align:center">
      <div style="font-size:30px;font-weight:800;color:var(--sda-rev)">₽ ${_sdFmtRub(rows[0].revenue)}</div>
      <div style="font-size:12px;color:var(--t3);margin-top:4px">за сегодня</div></div>`;
    return;
  }
  const W = 1200, H = 200, padL = 10, padR = 10, padT = 14, padB = 26;
  const iw = W - padL - padR, ih = H - padT - padB;
  const vals = rows.map(r => parseFloat(r.revenue) || 0);
  const max = Math.max(...vals, 1);
  const pts = vals.map((v, i) => [
    padL + (rows.length === 1 ? iw / 2 : i * iw / (rows.length - 1)),
    padT + ih - (v / max) * ih,
  ]);
  // Catmull-Rom → cubic bezier (сглаживание)
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i],
          p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  const area = `${d} L ${pts[pts.length - 1][0].toFixed(1)} ${H - padB} L ${pts[0][0].toFixed(1)} ${H - padB} Z`;
  const step = Math.ceil(rows.length / 14);
  const fmtD = (s) => { const [, m, dd] = String(s).split('-'); return `${parseInt(dd)}.${m}`; };
  const xLabels = rows.map((r, i) =>
    (rows.length <= 14 || i % step === 0)
      ? `<text class="sd-chart-x" x="${pts[i][0].toFixed(1)}" y="${H - 8}" text-anchor="middle">${fmtD(r.d)}</text>` : ''
  ).join('');
  const pathLen = 2200; // безопасно больше реальной длины — для stroke-dash анимации

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:200px">
      <defs>
        <linearGradient id="sdAg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--sda-rev)" stop-opacity=".25"/>
          <stop offset="100%" stop-color="var(--sda-rev)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path class="sd-chart-area" d="${area}" fill="url(#sdAg)" style="opacity:0;transition:opacity .5s ease .4s"/>
      <path class="sd-chart-line" d="${d}"
        style="stroke-dasharray:${pathLen};stroke-dashoffset:${pathLen};transition:stroke-dashoffset .9s ease"/>
      <line class="sd-chart-guide" x1="0" y1="${padT}" x2="0" y2="${H - padB}"/>
      <circle class="sd-chart-dot" r="5" cx="0" cy="0"/>
      ${xLabels}
      <rect x="0" y="0" width="${W}" height="${H}" fill="transparent" style="cursor:crosshair"/>
    </svg>
    <div class="sd-tip"></div>`;

  const svg = wrap.querySelector('svg');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const line = svg.querySelector('.sd-chart-line');
    const areaEl = svg.querySelector('.sd-chart-area');
    if (reduced) { line.style.transition = 'none'; areaEl.style.transition = 'none'; }
    line.style.strokeDashoffset = '0';
    areaEl.style.opacity = '1';
  }));

  // Hover: ближайшая точка → направляющая + точка + тултип
  const guide = svg.querySelector('.sd-chart-guide');
  const dot = svg.querySelector('.sd-chart-dot');
  const tip = wrap.querySelector('.sd-tip');
  const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  svg.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width * W;
    let best = 0, bd = Infinity;
    pts.forEach((p, i) => { const dd = Math.abs(p[0] - x); if (dd < bd) { bd = dd; best = i; } });
    const [px, py] = pts[best];
    guide.setAttribute('x1', px); guide.setAttribute('x2', px);
    guide.style.opacity = '1';
    dot.setAttribute('cx', px); dot.setAttribute('cy', py);
    dot.style.opacity = '1';
    const [, m, dd2] = String(rows[best].d).split('-');
    tip.textContent = `${parseInt(dd2)} ${MON[parseInt(m) - 1]} · ₽ ${_sdFmtRub(rows[best].revenue)}`;
    // px в координатах viewBox → проценты контейнера; зажать чтобы не вылезал
    const leftPct = Math.min(92, Math.max(8, px / W * 100));
    tip.style.left = leftPct + '%';
    tip.style.top = (py / H * 100) + '%';
    tip.style.opacity = '1';
  });
  svg.addEventListener('mouseleave', () => {
    guide.style.opacity = '0'; dot.style.opacity = '0'; tip.style.opacity = '0';
  });
}
```

- [ ] **Step 5.2: Проверка в браузере**

Перезагрузить страницу (Playwright), пресет «Месяц». Expected: плавная кривая «рисуется», под ней градиент, hover показывает направляющую/точку/тултип «5 июн · ₽ 58 600». Пресет «Сегодня» → плашка «₽ N за сегодня». Скриншот.

- [ ] **Step 5.3: Commit**

```bash
node --check frontend/js/pages/staff-dashboard.js
git add frontend/js/pages/staff-dashboard.js
git commit -m "feat(staff-dashboard): SVG-график — сглаженная градиентная область, hover-тултип, анимация"
```

---

### Task 6: JS — Топ-5 с барами, короной и сортировкой

**Files:**
- Modify: `frontend/js/pages/staff-dashboard.js` — заменить заглушку `_sdRenderTop5`; в `_sdState` добавить поле сортировки

- [ ] **Step 6.1: Состояние сортировки**

В объявление `_sdState` (строка ~12) добавить ключ:

```js
const _sdState = { from: null, to: null, preset: 'week', t5: { key: 'total_amount', dir: 'desc' } };
```

- [ ] **Step 6.2: Реализация**

```js
// Топ-5 услуг: рейтинг с барами (доля в выручке топ-5) + сортировка по
// «Кол-во»/«Выручка». Места пересчитываются под текущий порядок.
function _sdRenderTop5(wrap, rows) {
  if (!wrap) return;
  if (!rows.length) {
    wrap.innerHTML = '<div class="pp-hint" style="margin-top:10px">Нет данных за период</div>';
    return;
  }
  const { key, dir } = _sdState.t5;
  const sorted = [...rows].sort((a, b) =>
    dir === 'desc' ? (parseFloat(b[key]) || 0) - (parseFloat(a[key]) || 0)
                   : (parseFloat(a[key]) || 0) - (parseFloat(b[key]) || 0));
  const maxRev = Math.max(...rows.map(t => parseFloat(t.total_amount) || 0), 1);
  const arrow = (k) => key === k ? (dir === 'desc' ? ' ↓' : ' ↑') : '';
  wrap.innerHTML = `
    <div class="sd-t5-h" style="margin-top:10px">
      <span></span><span>Услуга</span>
      <span class="srt" data-k="cnt">Кол-во${arrow('cnt')}</span>
      <span class="srt" data-k="total_amount">Выручка${arrow('total_amount')}</span>
    </div>
    ${sorted.map((t, i) => {
      const pct = Math.round((parseFloat(t.total_amount) || 0) / maxRev * 100);
      return `
      <div class="sd-t5-row ${i === 0 ? 'lead' : ''}">
        <span class="sd-t5-rank">${i === 0 ? '👑' : i + 1}</span>
        <div class="sd-t5-name">
          <span title="${_sdEsc(t.service_name)}">${_sdEsc(t.service_name)}</span>
          <div class="sd-t5-bar"><i data-w="${pct}"></i></div>
        </div>
        <span class="sd-t5-cnt">${t.cnt}</span>
        <span class="sd-t5-sum">₽ ${_sdFmtRub(t.total_amount)}</span>
      </div>`;
    }).join('')}`;
  // Анимация баров
  requestAnimationFrame(() => requestAnimationFrame(() => {
    wrap.querySelectorAll('.sd-t5-bar i').forEach(i => { i.style.width = (i.dataset.w || 0) + '%'; });
  }));
  // Сортировка: клик по заголовку — без полного _sdRender (данные те же)
  wrap.querySelectorAll('.srt').forEach(h => {
    h.onclick = () => {
      const k = h.dataset.k;
      _sdState.t5 = { key: k, dir: _sdState.t5.key === k && _sdState.t5.dir === 'desc' ? 'asc' : 'desc' };
      _sdRenderTop5(wrap, rows);
    };
  });
}
```

- [ ] **Step 6.3: Проверка в браузере**

Expected: 5 строк, корона у первой, бары растут при загрузке; клик «Кол-во» пересортирует (стрелка ↓), повторный клик — ↑; «Выручка» — то же. Места и корона следуют текущему порядку. Скриншот.

- [ ] **Step 6.4: Commit**

```bash
node --check frontend/js/pages/staff-dashboard.js
git add frontend/js/pages/staff-dashboard.js
git commit -m "feat(staff-dashboard): топ-5 — рейтинг с барами, короной и сортировкой по колонкам"
```

---

### Task 7: Тёмная тема + мобильная + приёмка по спеке

- [ ] **Step 7.1: Тёмная тема (Playwright)**

Переключить тему в UI (кнопка темы в topbar). Expected: тёмные пастели из `[data-theme="dark"]`, читаемые акценты, белые круги иконок стали тёмными (`var(--card)`), график виден. Скриншот. Если какой-то фон «грязный» — поправить hex в `features.css` и закоммитить фикс.

- [ ] **Step 7.2: Мобильная ширина**

Playwright viewport 390×844. Expected: hero переносится, карточки в 1–2 колонки (существующие медиа-запросы `sd-g3/sd-g4`), горизонтального скролла нет, топ-5 влезает. Скриншот.

- [ ] **Step 7.3: Прогон критериев приёмки спеки**

Сверить все 8 пунктов «Критерии приёмки» из спеки. Отдельно: проверить unlinked-пользователя (можно временно `UPDATE users SET staff_member_id=NULL WHERE id=<test>` через mcp__postgres__query, затем вернуть) — плашка «Профиль не привязан» работает.

- [ ] **Step 7.4: Commit фиксов (если были)**

```bash
git add -A frontend/
git commit -m "fix(staff-dashboard): доводка тёмной темы и мобильной вёрстки редизайна"
```

---

### Task 8: Merge + deploy

- [ ] **Step 8.1: Merge в main и push**

```bash
git checkout main && git merge feature/sd-pastel-redesign && git push origin main
```

- [ ] **Step 8.2: Deploy prod**

```bash
ssh root@217.114.0.254 "cd /root/loyalpro_new && git pull origin main && pm2 restart loyalpro"
```

ВНИМАНИЕ: на проде может быть незакоммиченный мусор → если pull падает, `git stash` перед pull (как делали ранее).

- [ ] **Step 8.3: Прод-смок**

Залогиниться на https://www.zumrudin.ru специалистом (testtest@mail.ru / Admin123), проверить дашборд визуально + что цифры совпадают с дев (та же Гатауллина за текущий месяц). Скриншот пользователю.
