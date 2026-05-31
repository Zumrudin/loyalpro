# Адаптация staff-фронтенда под мобильные телефоны — План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать staff-SPA LoyalPro полностью пригодной для работы с телефона (≤700px) без изменения десктопа.

**Architecture:** Слой мобильных переопределений поверх десктопных стилей. CSS-оверрайды в `@media`-блоках в конце `css/base.css` и `css/features.css`; точечный JS для бургер-drawer в `js/core/nav.js`; атрибуты `data-label` в рендере таблиц «Клиенты»/«Записи» для превращения строк в карточки.

**Tech Stack:** Vanilla JS SPA, CSS (без препроцессоров/фреймворков), бэкенд Express отдаёт фронтенд на `:3001`. Верификация — MCP Playwright (по правилу CLAUDE.md: UI-тестирование только через Playwright MCP, не bash).

---

## Замечание по верификации

Для презентационного SPA в репозитории нет фреймворка юнит-тестов фронтенда (тесты в `backend/` — node-скрипты для API). Поэтому верификация каждой задачи — **визуальная через MCP Playwright** против запущенного dev-сервера:

```bash
cd backend && npm run dev    # поднимает сервер на http://localhost:3001
```

Затем в Playwright MCP: `browser_resize` до 390×844 (телефон) или 1280×800 (десктоп-регрессия), `browser_navigate` на `http://localhost:3001`, логин (исполнителю нужны валидные креды владельца/админа для разделов owner/admin), `browser_snapshot` / `browser_take_screenshot`, `browser_console_messages` для проверки отсутствия ошибок JS.

Где меняется JS-поведение (drawer, роле-навигация) — verification через Playwright обязательна (открыть/закрыть, проверить классы). Где меняется только CSS — verification визуальная (скриншот мобильного вьюпорта + скриншот десктопа на регрессию).

---

## Структура файлов

| Файл | Что меняем |
|------|-----------|
| `frontend/index.html` | Кнопка-бургер в `.topbar`; разметка `<aside class="mnav-drawer">` + оверлей |
| `frontend/css/base.css` | Блок `/* ─── MOBILE ─── */` в конце: топбар, drawer, карточки-таблицы, модалки, тач-таргеты, сетки |
| `frontend/css/features.css` | Мобильные оверрайды настроек (sidebar→чипы) и фото-кейсов |
| `frontend/js/core/nav.js` | `openMenu()`/`closeMenu()`; авто-закрытие в `nav()`; расширение `applyRoleNav` на пункты drawer |
| `frontend/js/pages/clients.js` | `data-label` в рендере строк таблицы клиентов |
| `frontend/js/pages/records.js` | `data-label` в рендере строк таблицы записей |

Все мобильные CSS-правила скоупятся под `@media(max-width:700px)` (и `≤480px` для донастроек). Карточный режим таблиц скоупится под `#page-clients` / `#page-records`, чтобы не задеть прочие таблицы (логи, история, пользователи).

---

## Task 1: Базовый мобильный слой (топбар, паддинги, тач-таргеты)

**Files:**
- Modify: `frontend/css/base.css` (добавить блок в конец файла)

Существующий медиазапрос `base.css:188` `@media(max-width:700px){.tb-nav{display:none}.g2{grid-template-columns:1fr}}` оставляем — его дополнит новый консолидированный блок.

- [ ] **Step 1: Добавить консолидированный мобильный блок в конец `frontend/css/base.css`**

```css

/* ═══════════════════════════════════════════════════════════
   MOBILE  (≤700px телефоны)  — слой переопределений
   ═══════════════════════════════════════════════════════════ */
@media(max-width:700px){
  /* — Топбар — */
  .topbar{padding:0 12px;gap:8px}
  .tb-burger{display:flex}                 /* кнопка-бургер (Task 2) */
  .tb-ln{font-size:13px}
  /* прячем из шапки то, что переезжает в drawer (Task 4) */
  .topbar #syncSt,
  .topbar #syncBtn,
  .topbar #topName,
  .topbar .tb-logout{display:none}
  .tb-right{gap:6px}

  /* — Контент: меньше паддинги — */
  .content{padding:14px}

  /* — Тач-таргеты — */
  .btn{min-height:38px}
  .btn-sm{min-height:32px}
  /* iOS Safari не зумит поля при font-size>=16px */
  input,select,textarea{font-size:16px}

  /* — Кнопка-бургер видна только на мобиле — */
}

/* десктоп: бургер скрыт всегда */
.tb-burger{display:none}

@media(max-width:480px){
  .content{padding:10px}
  .tb-ln{display:none}                      /* совсем узко — прячем текст лого */
}
```

- [ ] **Step 2: Verify (Playwright) — топбар на мобиле не переполняется**

Запустить `cd backend && npm run dev`. В Playwright MCP: `browser_resize` 390×844 → `browser_navigate` `http://localhost:3001` → логин → `browser_take_screenshot`.
Expected: шапка в одну строку, нет горизонтального скролла шапки; статус синка/кнопка «Синхронизировать»/имя/«Выйти» не видны в шапке (они появятся в drawer после Task 4). Кнопка-бургер ещё не отрисована (добавим в Task 2) — это ок.

- [ ] **Step 3: Commit**

```bash
git add frontend/css/base.css
git commit -m "feat(mobile): base mobile layer — topbar trim, padding, touch targets"
```

---

## Task 2: Бургер-кнопка и drawer (разметка + CSS + открытие/закрытие)

**Files:**
- Modify: `frontend/index.html` (топбар + новый блок drawer)
- Modify: `frontend/css/base.css` (стили бургера и drawer)
- Modify: `frontend/js/core/nav.js` (`openMenu`/`closeMenu`)

- [ ] **Step 1: Добавить кнопку-бургер в `.topbar`**

В `frontend/index.html` найти начало топбара:

```html
  <div class="topbar">
    <div class="tb-logo">
```

Заменить на (бургер перед лого):

```html
  <div class="topbar">
    <button class="tb-burger" id="tbBurger" onclick="openMenu()" aria-label="Меню">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
    <div class="tb-logo">
```

- [ ] **Step 2: Добавить разметку drawer + оверлей**

В `frontend/index.html` сразу ПОСЛЕ закрывающего `</div>` топбара (перед `.content` / первым `.page`) вставить:

```html
  <!-- ═══ MOBILE DRAWER ═══ -->
  <div class="mnav-ov" id="mnavOv" onclick="if(event.target===this)closeMenu()"></div>
  <aside class="mnav-drawer" id="mnavDrawer">
    <div class="mnav-hdr">
      <div class="t-av" id="mnavAv">?</div>
      <div class="mnav-hdr-txt">
        <div class="mnav-name" id="mnavName"></div>
        <div class="mnav-role" id="mnavRole"></div>
      </div>
      <button class="mnav-close" onclick="closeMenu()" aria-label="Закрыть">✕</button>
    </div>
    <nav class="mnav-list" id="mnavList">
      <div class="tn" data-p="dashboard" data-roles="owner,admin" onclick="nav(this)">Дашборд</div>
      <div class="tn" data-p="clients" data-roles="owner,admin" onclick="nav(this)">Клиенты</div>
      <div class="tn" data-p="records" data-roles="owner,admin" onclick="nav(this)">Записи</div>
      <div class="tn" data-p="staff-analytics" data-roles="owner,admin" onclick="nav(this)">Сотрудники</div>
      <div class="tn" data-p="segments" data-roles="owner,admin" onclick="nav(this)">Сегменты</div>
      <div class="tn" data-p="home-care" data-roles="owner,admin,specialist" onclick="nav(this)">Уход</div>
      <div class="tn" data-p="patient-portfolio" data-roles="owner,admin,specialist" onclick="nav(this)">📷 Фото-кейсы</div>
      <div class="tn" data-p="settings" data-roles="owner,admin" onclick="nav(this)">Настройки</div>
      <div class="tn" data-p="users" data-roles="owner" onclick="nav(this)">Пользователи</div>
    </nav>
    <div class="mnav-foot">
      <div id="mnavSyncSt" style="font-size:11.5px;color:var(--t3)"></div>
      <button class="btn btn-sec btn-full" onclick="triggerSync()">
        <svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Синхронизировать
      </button>
      <button class="btn btn-sec btn-full" onclick="doLogout()">Выйти</button>
    </div>
  </aside>
```

> Примечание: дублирование пунктов навигации (drawer + `#mainNav`) намеренно — десктоп использует `#mainNav`, мобила — `#mnavList`. Роле-фильтр в Task 3 покрывает оба набора.

- [ ] **Step 3: Добавить CSS бургера и drawer в `frontend/css/base.css`** (внутри уже существующего блока MOBILE для бургер-вида + общие правила drawer вне медиазапроса)

Добавить ПОСЛЕ блока MOBILE из Task 1:

```css
/* — Кнопка-бургер — */
.tb-burger{align-items:center;justify-content:center;background:transparent;border:none;color:var(--t1);cursor:pointer;padding:6px;border-radius:8px}
.tb-burger:hover{background:var(--bg)}

/* — Drawer (скрыт на десктопе) — */
.mnav-ov{position:fixed;inset:0;background:rgba(0,0,0,.45);opacity:0;visibility:hidden;transition:opacity .2s,visibility .2s;z-index:90}
.mnav-ov.open{opacity:1;visibility:visible}
.mnav-drawer{position:fixed;top:0;left:0;height:100%;width:80vw;max-width:300px;background:var(--card);border-right:1px solid var(--bd);
  transform:translateX(-100%);transition:transform .22s ease;z-index:95;display:flex;flex-direction:column}
.mnav-drawer.open{transform:translateX(0)}
.mnav-hdr{display:flex;align-items:center;gap:10px;padding:16px 14px;border-bottom:1px solid var(--bd)}
.mnav-hdr-txt{flex:1;min-width:0}
.mnav-name{font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mnav-role{font-size:11px;color:var(--t3)}
.mnav-close{background:transparent;border:none;font-size:18px;color:var(--t3);cursor:pointer;padding:4px 8px}
.mnav-list{flex:1;overflow-y:auto;padding:8px}
.mnav-list .tn{display:block;padding:12px 14px;border-radius:8px;font-size:15px;margin-bottom:2px}
.mnav-foot{border-top:1px solid var(--bd);padding:12px;display:flex;flex-direction:column;gap:8px}
```

- [ ] **Step 4: Добавить `openMenu`/`closeMenu` + Esc-обработчик в `frontend/js/core/nav.js`**

В конец файла `frontend/js/core/nav.js`:

```javascript

// ── MOBILE DRAWER ──
function openMenu() {
  document.getElementById('mnavOv')?.classList.add('open');
  document.getElementById('mnavDrawer')?.classList.add('open');
}
function closeMenu() {
  document.getElementById('mnavOv')?.classList.remove('open');
  document.getElementById('mnavDrawer')?.classList.remove('open');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
```

- [ ] **Step 5: Verify (Playwright) — drawer открывается и закрывается**

Запустить dev-сервер, Playwright 390×844, логин. Действия:
1. `browser_click` по `#tbBurger` → `browser_take_screenshot`. Expected: панель выехала слева, оверлей затемнён, видны пункты + футер с «Синхронизировать»/«Выйти».
2. `browser_click` по оверлею (вне панели) → панель уехала.
3. Снова открыть, `browser_press_key` Escape → панель уехала.
4. `browser_console_messages` → нет ошибок.
Десктоп-регрессия: `browser_resize` 1280×800 → бургер не виден, drawer не виден, верхнее меню на месте.

- [ ] **Step 6: Commit**

```bash
git add frontend/index.html frontend/css/base.css frontend/js/core/nav.js
git commit -m "feat(mobile): burger button + slide-in navigation drawer"
```

---

## Task 3: Роле-навигация для drawer + авто-закрытие при переходе

**Files:**
- Modify: `frontend/js/core/nav.js` (`applyRoleNav`, `nav`, `launchApp`)

- [ ] **Step 1: Расширить `applyRoleNav` на пункты drawer**

В `frontend/js/core/nav.js` заменить тело функции `applyRoleNav`:

```javascript
function applyRoleNav(role) {
  const navItems = document.querySelectorAll('#mainNav .tn');
  let firstVisible = null;
  navItems.forEach(item => {
    const roles = (item.dataset.roles || '').split(',').map(r => r.trim());
    if (roles.includes(role)) {
      item.style.display = '';
      if (!firstVisible) firstVisible = item;
    } else {
      item.style.display = 'none';
    }
  });
  navItems.forEach(n => n.classList.remove('active'));
  if (firstVisible) firstVisible.classList.add('active');
  return firstVisible?.dataset?.p || 'home-care';
}
```

на:

```javascript
function applyRoleNav(role) {
  // покрываем оба набора пунктов: десктопное меню (#mainNav) и мобильный drawer (#mnavList)
  const navItems = document.querySelectorAll('#mainNav .tn, #mnavList .tn');
  let firstVisible = null;
  navItems.forEach(item => {
    const roles = (item.dataset.roles || '').split(',').map(r => r.trim());
    if (roles.includes(role)) {
      item.style.display = '';
      if (!firstVisible) firstVisible = item;
    } else {
      item.style.display = 'none';
    }
  });
  navItems.forEach(n => n.classList.remove('active'));
  // первый видимый из #mainNav — стартовая страница
  const firstMain = document.querySelector('#mainNav .tn:not([style*="display: none"])');
  if (firstMain) firstMain.classList.add('active');
  return firstMain?.dataset?.p || 'home-care';
}
```

> CSS `.mnav-list .tn{display:block}` остаётся в силе: `style.display=''` снимает инлайн-`none`, и пункт показывается как `block` из CSS. Скрытый пункт получает инлайн `display:none`.

- [ ] **Step 2: Авто-закрытие drawer при переходе — дополнить `nav()`**

В `frontend/js/core/nav.js` в функции `nav(el)` заменить первую строку:

```javascript
function nav(el) {
  document.querySelectorAll('.tn').forEach(n => n.classList.remove('active'));
```

на:

```javascript
function nav(el) {
  closeMenu();                         // закрыть drawer, если переход был из него
  document.querySelectorAll('.tn').forEach(n => n.classList.remove('active'));
```

> `document.querySelectorAll('.tn')` уже захватывает и drawer-пункты (у них класс `.tn`), поэтому подсветка active синхронизируется между обоими меню без доп. кода.

- [ ] **Step 3: Заполнить шапку drawer (аватар/имя/роль) в `launchApp`**

В `frontend/js/core/nav.js` в `launchApp`, после строк, заполняющих `topAv`/`topName`:

```javascript
  document.getElementById('topAv').textContent  = (ME.name || ME.email || '?').slice(0, 2).toUpperCase();
  document.getElementById('topName').textContent = ME.name || ME.email;
```

добавить:

```javascript
  // шапка мобильного drawer
  const ROLE_LBL = { owner: 'Владелец', admin: 'Администратор', specialist: 'Специалист' };
  document.getElementById('mnavAv').textContent   = (ME.name || ME.email || '?').slice(0, 2).toUpperCase();
  document.getElementById('mnavName').textContent = ME.name || ME.email;
  document.getElementById('mnavRole').textContent = ROLE_LBL[ME.role] || ME.role || '';
```

- [ ] **Step 4: Verify (Playwright) — роле-фильтр в drawer и переход**

Войти владельцем (owner), 390×844, открыть бургер: видны все 9 пунктов, шапка drawer показывает имя+«Владелец». Тап по «Клиенты» → drawer закрылся, открылась страница клиентов, в drawer/верхнем меню пункт «Клиенты» active.
Если доступен аккаунт specialist — войти им: в drawer видны только «Уход» и «Фото-кейсы».
`browser_console_messages` → без ошибок.

- [ ] **Step 5: Commit**

```bash
git add frontend/js/core/nav.js
git commit -m "feat(mobile): role-aware drawer nav + auto-close + drawer header"
```

---

## Task 4: Синхронизация статуса синка в футер drawer

**Files:**
- Modify: `frontend/js/core/*` или место, где обновляется `#syncSt` (найти грепом)

Кнопка «Синхронизировать»/«Выйти» уже в футере drawer (Task 2). Осталось дублировать текст статуса синка в `#mnavSyncSt`, т.к. оригинальный `#syncSt` скрыт на мобиле.

- [ ] **Step 1: Найти, где пишется `#syncSt`**

Run: `grep -rn "syncSt\|getElementById('syncSt')\|#syncSt" frontend/js`
Expected: одно-два места, где устанавливается `.textContent`/`.innerHTML` элемента `syncSt` (например в `app.js` или `core/utils.js`).

- [ ] **Step 2: Зеркалировать значение в `#mnavSyncSt`**

В каждом месте, где присваивается `document.getElementById('syncSt').textContent = X` (или `.innerHTML`), добавить сразу следующей строкой зеркальное присваивание. Пример — если найдено:

```javascript
document.getElementById('syncSt').textContent = txt;
```

добавить под ним:

```javascript
const _mnavSt = document.getElementById('mnavSyncSt'); if (_mnavSt) _mnavSt.textContent = txt;
```

(Подставить фактическое имя переменной/способ присваивания из найденного кода; если используется `.innerHTML`, зеркалить `.innerHTML`.)

- [ ] **Step 3: Verify (Playwright)**

390×844, открыть drawer → в футере над кнопкой «Синхронизировать» виден тот же статус, что показывается на десктопе в шапке. Нажать «Синхронизировать» → статус обновляется и в drawer.

- [ ] **Step 4: Commit**

```bash
git add frontend/js
git commit -m "feat(mobile): mirror sync status into drawer footer"
```

---

## Task 5: Таблица «Клиенты» → карточки

**Files:**
- Modify: `frontend/js/pages/clients.js` (рендер строк — добавить `data-label`)
- Modify: `frontend/css/base.css` (карточный режим под `#page-clients`)

- [ ] **Step 1: Добавить `data-label` в рендер строк клиентов**

В `frontend/js/pages/clients.js` заменить блок рендера (около строки 84):

```javascript
    tb.innerHTML = d.clients.map(c => `
      <tr onclick="openCD(${c.id})">
        <td><div style="display:flex;align-items:center;gap:9px"><div class="av" style="background:${avc(c.name)};color:#fff;font-size:10px">${avi(c.name)}</div><div style="font-weight:600">${esc(c.name)}</div></div></td>
        <td style="color:var(--t2)">${esc(c.phone || '—')}</td>
        <td><span class="badge ${LVL_B[c.loyalty_level] || 'bgr'}">${LVL_L[c.loyalty_level] || '—'}</span></td>
        <td style="font-weight:700;color:var(--a)">${(c.bonus_balance || 0).toLocaleString('ru')}</td>
        <td>${parseFloat(c.total_spent || 0).toLocaleString('ru')} ₽</td>
        <td>${c.visits_count || 0}</td>
        <td style="color:var(--t3)">${c.last_visit_at ? new Date(c.last_visit_at).toLocaleDateString('ru', {day:'numeric',month:'short',year:'numeric'}) : '—'}</td>
        <td><button class="btn btn-sec btn-sm" onclick="event.stopPropagation();openCD(${c.id})">→</button></td>
      </tr>`).join('');
```

на (добавлены `data-label`, первой ячейке — класс `c-card-title`):

```javascript
    tb.innerHTML = d.clients.map(c => `
      <tr onclick="openCD(${c.id})">
        <td class="c-card-title"><div style="display:flex;align-items:center;gap:9px"><div class="av" style="background:${avc(c.name)};color:#fff;font-size:10px">${avi(c.name)}</div><div style="font-weight:600">${esc(c.name)}</div></div></td>
        <td data-label="Телефон" style="color:var(--t2)">${esc(c.phone || '—')}</td>
        <td data-label="Уровень"><span class="badge ${LVL_B[c.loyalty_level] || 'bgr'}">${LVL_L[c.loyalty_level] || '—'}</span></td>
        <td data-label="Бонусы" style="font-weight:700;color:var(--a)">${(c.bonus_balance || 0).toLocaleString('ru')}</td>
        <td data-label="Потрачено">${parseFloat(c.total_spent || 0).toLocaleString('ru')} ₽</td>
        <td data-label="Визитов">${c.visits_count || 0}</td>
        <td data-label="Последний визит" style="color:var(--t3)">${c.last_visit_at ? new Date(c.last_visit_at).toLocaleDateString('ru', {day:'numeric',month:'short',year:'numeric'}) : '—'}</td>
        <td class="c-card-arrow"><button class="btn btn-sec btn-sm" onclick="event.stopPropagation();openCD(${c.id})">→</button></td>
      </tr>`).join('');
```

- [ ] **Step 2: Добавить карточный CSS под `#page-clients` в `frontend/css/base.css`** (в конец файла)

```css
/* — Карточный режим таблицы клиентов на мобиле — */
@media(max-width:700px){
  #page-clients .tw{overflow:visible}
  #page-clients table,#page-clients tbody,#page-clients tbody tr,#page-clients tbody td{display:block;width:auto}
  #page-clients thead tr:first-child{display:none}              /* строка сортировки */
  /* строка фильтров → панель из чипов */
  #page-clients thead tr.filter-row{display:flex;flex-wrap:wrap;gap:8px;padding:0 0 12px}
  #page-clients thead tr.filter-row th{display:block;flex:1 1 46%;padding:0;border:none}
  /* карточка */
  #page-clients tbody tr{border:1px solid var(--bd);border-radius:var(--r);box-shadow:var(--sh);
    background:var(--card);padding:12px 14px;margin-bottom:10px}
  #page-clients tbody td{display:flex;justify-content:space-between;align-items:center;gap:12px;
    padding:5px 0;border:none;text-align:right}
  #page-clients tbody td::before{content:attr(data-label);color:var(--t3);font-size:12px;font-weight:600;text-align:left}
  #page-clients tbody td.c-card-title{justify-content:flex-start;padding-bottom:10px;margin-bottom:6px;border-bottom:1px solid var(--bd)}
  #page-clients tbody td.c-card-title::before{content:none}
  #page-clients tbody td.c-card-arrow{display:none}            /* дублирующая стрелка не нужна */
  #page-clients tbody td.empty{display:block;text-align:center}
  #page-clients tbody td.empty::before{content:none}
}
```

- [ ] **Step 3: Verify (Playwright) — клиенты карточками**

390×844, логин owner/admin → «Клиенты». Expected: каждая запись — карточка с именем+аватаром в шапке и парами «лейбл — значение» (Телефон, Уровень, Бонусы, Потрачено, Визитов, Последний визит); тап по карточке открывает модалку клиента; фильтры (имя/телефон/диапазоны/статус) видны и работают. Нет горизонтального скролла страницы.
Десктоп 1280: таблица выглядит как раньше (строки, шапка сортировки, фильтры в строке).

- [ ] **Step 4: Commit**

```bash
git add frontend/js/pages/clients.js frontend/css/base.css
git commit -m "feat(mobile): clients table renders as cards on phones"
```

---

## Task 6: Таблица «Записи» → карточки

**Files:**
- Modify: `frontend/js/pages/records.js` (рендер строк — добавить `data-label`)
- Modify: `frontend/css/base.css` (карточный режим под `#page-records`)

- [ ] **Step 1: Добавить `data-label` в рендер строк записей**

В `frontend/js/pages/records.js` заменить возвращаемый шаблон строки (около строки 79):

```javascript
      return `<tr>
        <td style="color:var(--t2);white-space:nowrap">
          ${formatVisitDate(r.visit_date_msk || r.visit_date)}
          ${timeStr ? `<br><span style="font-size:11px;color:var(--t3)">${timeStr}</span>` : ''}
        </td>
        <td><strong>${esc(r.client_name || '—')}</strong><br><span style="font-size:11px;color:var(--t3)">${esc(r.client_phone || '')}</span></td>
        <td style="color:var(--t2);font-size:12px">${esc(svc)}</td>
        <td style="color:var(--t2);font-size:12px">${esc(st)}</td>
        <td style="font-weight:600;text-align:right">${amt > 0 ? amt.toLocaleString('ru') + ' ₽' : '—'}</td>
        <td style="color:var(--a);font-weight:600;text-align:right">${accrued > 0 ? '+' + accrued.toLocaleString('ru') : '—'}</td>
        <td style="color:var(--danger);font-weight:600;text-align:right">${redeemed > 0 ? '-' + redeemed.toLocaleString('ru') : '—'}</td>
        <td style="white-space:nowrap"><span class="badge" style="${badgeStyle}">${esc(SL[displayStatus] || SL[status] || status)}</span>${paidMark}</td>
        <td><span class="badge bgr" style="font-size:10px">${esc({sync:'Синхр.',webhook:'Hook'}[r.source] || r.source || '—')}</span></td>
      </tr>`;
```

на (первая ячейка — `r-card-title`, остальным — `data-label`):

```javascript
      return `<tr>
        <td class="r-card-title" style="color:var(--t2);white-space:nowrap">
          ${formatVisitDate(r.visit_date_msk || r.visit_date)}
          ${timeStr ? `<span style="font-size:11px;color:var(--t3)"> · ${timeStr}</span>` : ''}
        </td>
        <td data-label="Клиент"><strong>${esc(r.client_name || '—')}</strong><br><span style="font-size:11px;color:var(--t3)">${esc(r.client_phone || '')}</span></td>
        <td data-label="Услуги" style="color:var(--t2);font-size:12px">${esc(svc)}</td>
        <td data-label="Мастер" style="color:var(--t2);font-size:12px">${esc(st)}</td>
        <td data-label="Сумма" style="font-weight:600;text-align:right">${amt > 0 ? amt.toLocaleString('ru') + ' ₽' : '—'}</td>
        <td data-label="Начислено" style="color:var(--a);font-weight:600;text-align:right">${accrued > 0 ? '+' + accrued.toLocaleString('ru') : '—'}</td>
        <td data-label="Списано" style="color:var(--danger);font-weight:600;text-align:right">${redeemed > 0 ? '-' + redeemed.toLocaleString('ru') : '—'}</td>
        <td data-label="Статус" style="white-space:nowrap"><span class="badge" style="${badgeStyle}">${esc(SL[displayStatus] || SL[status] || status)}</span>${paidMark}</td>
        <td data-label="Источник"><span class="badge bgr" style="font-size:10px">${esc({sync:'Синхр.',webhook:'Hook'}[r.source] || r.source || '—')}</span></td>
      </tr>`;
```

> Заметка: в `r-card-title` `<br>` перед временем заменён на ` · `, чтобы дата+время читались одной строкой в заголовке карточки.

- [ ] **Step 2: Добавить карточный CSS под `#page-records` в `frontend/css/base.css`** (в конец файла)

```css
/* — Карточный режим таблицы записей на мобиле — */
@media(max-width:700px){
  #page-records .tw{overflow:visible}
  #page-records table,#page-records thead,#page-records tbody,#page-records tbody tr,#page-records tbody td{display:block;width:auto}
  #page-records thead{display:none}                 /* у записей фильтры отдельно над таблицей */
  #page-records tbody tr{border:1px solid var(--bd);border-radius:var(--r);box-shadow:var(--sh);
    background:var(--card);padding:12px 14px;margin-bottom:10px}
  #page-records tbody td{display:flex;justify-content:space-between;align-items:center;gap:12px;
    padding:5px 0;border:none;text-align:right}
  #page-records tbody td::before{content:attr(data-label);color:var(--t3);font-size:12px;font-weight:600;text-align:left;flex-shrink:0}
  #page-records tbody td.r-card-title{justify-content:flex-start;padding-bottom:10px;margin-bottom:6px;
    border-bottom:1px solid var(--bd);font-weight:700;color:var(--t1)}
  #page-records tbody td.r-card-title::before{content:none}
  #page-records tbody td.empty{display:block;text-align:center}
  #page-records tbody td.empty::before{content:none}
  /* пагинация записей — крупнее, переносимая */
  #recordsPager{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
  #recordsPager .btn{min-height:34px;padding:4px 12px}
}
```

> Проверить фактический `id` контейнера пагинации записей: в `records.js` это элемент, в который пишется `el.innerHTML` (см. `renderRecordsPager`). Если id отличается от `recordsPager`, подставить корректный.

- [ ] **Step 3: Verify (Playwright) — записи карточками**

390×844 → «Записи», задать период/применить. Expected: каждая запись — карточка с датой+временем в заголовке и парами «лейбл — значение» (Клиент, Услуги, Мастер, Сумма, Начислено, Списано, Статус, Источник); пагинация кнопками переносится и кликается; фильтры над таблицей (период/телефон/ФИО/статус) на месте и переносятся. Нет горизонтального скролла страницы.
Десктоп 1280: таблица как раньше.

- [ ] **Step 4: Commit**

```bash
git add frontend/js/pages/records.js frontend/css/base.css
git commit -m "feat(mobile): records table renders as cards on phones"
```

---

## Task 7: Настройки — sidebar → горизонтальные чипы

**Files:**
- Modify: `frontend/css/features.css` (мобильные оверрайды настроек)

`.stg-sidebar` (`base.css:149`) — вертикальный список 224px. На мобиле превращаем в горизонтально-скроллящуюся полосу.

- [ ] **Step 1: Добавить мобильный блок настроек в конец `frontend/css/features.css`**

```css

/* ─── MOBILE: настройки ─── */
@media(max-width:700px){
  /* контейнер настроек (sidebar + content) — в колонку */
  #page-settings .stg-sidebar{
    width:100%;flex-shrink:0;position:static;max-height:none;
    border-right:none;border-bottom:1px solid var(--bd);
    display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;
    padding:8px;white-space:nowrap;-webkit-overflow-scrolling:touch}
  /* группы разворачиваем в одну строку чипов */
  #page-settings .stg-group{display:contents}
  #page-settings .stg-group-lbl,
  #page-settings .stg-sep{display:none}             /* подписи групп/разделители прячем на мобиле */
  #page-settings .stg-item{flex:0 0 auto;margin:0;padding:8px 12px;border:1px solid var(--bd);border-radius:20px;font-size:13px}
  #page-settings .stg-item.active{border-color:var(--a)}
  #page-settings .stg-content{padding:16px;max-width:none}
}
```

> Контейнер настроек (родитель `.stg-sidebar` + `.stg-content`) — flex-row на десктопе. `display:contents` на `.stg-group` поднимает `.stg-item` в флекс-контейнер `.stg-sidebar`, чтобы чипы легли в одну прокручиваемую строку. Если разметка использует иной id страницы настроек — подставить фактический (проверить: `grep -n 'id="page-settings"' frontend/index.html`; страница может называться `page-settings`).

- [ ] **Step 2: Verify (Playwright) — настройки на мобиле**

390×844 (owner) → «Настройки». Expected: разделы — горизонтальная прокручиваемая полоса чипов сверху; активный чип подсвечен; контент раздела на всю ширину; формы в одну колонку, поля не зумят при фокусе. Переключение разделов работает.
Десктоп 1280: вертикальный sidebar 224px как раньше, группы/разделители видны.

- [ ] **Step 3: Commit**

```bash
git add frontend/css/features.css
git commit -m "feat(mobile): settings sidebar becomes horizontal chip strip"
```

---

## Task 8: Модалки (bottom-sheet) + одноколоночные сетки + фото-кейсы

**Files:**
- Modify: `frontend/css/base.css` (модалки, общие сетки)
- Modify: `frontend/css/features.css` (фото-кейсы ≤480px при необходимости)

- [ ] **Step 1: Добавить мобильные правила модалок и сеток в конец `frontend/css/base.css`**

```css
/* ─── MOBILE: модалки и сетки ─── */
@media(max-width:700px){
  .modal{width:100%;max-width:100%;max-height:92vh;border-radius:16px 16px 0 0;padding:16px}
  .ov{align-items:flex-end}                 /* модалка прижата к низу (bottom-sheet) */
  .g3,.g32,.g2{grid-template-columns:1fr}   /* любые многоколоночные сетки → 1 колонка */
}
@media(max-width:480px){
  #page-patient-portfolio .pp-feed{grid-template-columns:1fr}   /* фото-кейсы в 1 колонку на узких */
}
```

> Проверить, что `.ov` — это оверлей-обёртка модалок (см. `base.css:166` рядом с `.modal`, селектор `.ov.open .modal`). Если центрирование задаётся иначе — подставить корректный селектор оверлея.

- [ ] **Step 2: Verify (Playwright) — модалки и сетки**

390×844: открыть модалку «+ Начислить / Списать» (страница «Клиенты») и модалку создания фото-кейса. Expected: модалка во всю ширину, прижата к низу, прокручивается, форма в одну колонку, кнопки доступны пальцем. Дашборд/сетки — без двух-трёхколоночной тесноты. Фото-кейсы на 390px читаемы (на ≤480 — одна колонка).
Десктоп 1280: модалки по центру 520px как раньше; сетки многоколоночные.

- [ ] **Step 3: Commit**

```bash
git add frontend/css/base.css frontend/css/features.css
git commit -m "feat(mobile): bottom-sheet modals + single-column grids + portfolio"
```

---

## Task 9: Сквозная верификация всех разделов + регрессия десктопа

**Files:** нет (только проверка)

- [ ] **Step 1: Полный мобильный прогон (Playwright 390×844, owner)**

Запустить dev-сервер. Войти владельцем. Для КАЖДОГО из 9 разделов: открыть бургер → перейти → `browser_take_screenshot` + `browser_console_messages`. Чек-лист на каждом:
- нет горизонтального скролла страницы (кроме намеренного скролла внутри лог-таблиц настроек/истории клиента);
- контент читаем, элементы не наезжают;
- интерактив (кнопки/поля) доступен пальцем.
Дополнительно: «Клиенты» и «Записи» — карточки; «Настройки» — чипы; модалки — bottom-sheet.

- [ ] **Step 2: Прогон на узком экране (360px)**

`browser_resize` 360×740 → пройтись по «Клиенты», «Записи», «Настройки», открыть бургер и модалку. Expected: шапка не переполняется, карточки/чипы не ломаются, нет горизонтального скролла.

- [ ] **Step 3: Регрессия десктопа (1280×800)**

`browser_resize` 1280×800 → пройтись по всем разделам. Expected: визуально идентично состоянию до изменений — верхнее меню, таблицы строками, sidebar настроек 224px, модалки по центру. Бургер/drawer не видны.

- [ ] **Step 4: Сверка с критериями готовности**

Открыть `docs/superpowers/specs/2026-05-31-staff-mobile-adaptation-design.md`, пройти по разделу «Критерии готовности» (6 пунктов) и подтвердить каждый по результатам прогонов. Зафиксировать в финальном сообщении, какие пункты подтверждены и приложить мобильный + десктопный скриншоты ключевых экранов.

- [ ] **Step 5: Финальный commit (если по итогам прогонов были донастройки)**

```bash
git add -A
git commit -m "fix(mobile): polish from cross-section verification"
```

---

## Self-review notes

- **Покрытие spec:** Брейкпоинты/файлы (Task 1), навигация бургер+drawer (Tasks 2–4), таблицы→карточки (Tasks 5–6), настройки sidebar→чипы (Task 7), модалки/сетки/тач-таргеты (Tasks 1, 8), тестирование (Task 9). Все 5 секций дизайна и 6 критериев готовности покрыты.
- **Вне scope** (mobile Expo, бэкенд, редизайн десктопа, карточки для лог-таблиц) — не затрагивается ни одной задачей. ✓
- **Согласованность имён:** `openMenu`/`closeMenu` (Task 2) используются в `nav()` (Task 3) и onclick разметки (Task 2). Классы `.tb-burger`, `.mnav-ov`, `.mnav-drawer`, `.mnav-list`, `.c-card-title`/`.c-card-arrow`, `.r-card-title` согласованы между HTML/CSS/JS. ✓
- **Точки, требующие сверки во время исполнения (явно отмечены в задачах):** фактический способ присваивания `#syncSt` (Task 4), id контейнера пагинации записей (Task 6), id страницы настроек и селектор оверлея модалок (Tasks 7–8). Это не плейсхолдеры реализации, а проверки соответствия фактической разметке.
