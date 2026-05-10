# Glass Theme — Foundation & Dashboard Pilot (Sub-project 1)

**Дата:** 2026-05-10
**Источник дизайна:** `frontend/glass-preview.html` («Pistachio Glass» mock).
**Статус:** design approved, готов к написанию плана.

## Контекст

Стафф-фронтенд LoyalPro построен на топбар-навигации со светлой/тёмной темой, переключаемой кнопкой `🌙` в шапке (`frontend/js/core/theme.js`, `[data-theme="dark"]` в `base.css`). Существует 9 страниц: Дашборд, Клиенты, Записи, Сегменты, Сотрудники, Домашний уход, Портфолио, Настройки, Пользователи.

В мае 2026 был создан статичный preview `frontend/glass-preview.html` — новый визуальный язык (cream/olive палитра в духе Estée Lauder, glassmorphism, sidebar-навигация, aurora-orbs на фоне). Preview покрывает только Дашборд и не интегрирован с SPA.

Решение: натянуть этот дизайн как сменяемую тему. Ввиду масштаба работа декомпозируется на sub-projects:

- **Sub-project 1 (этот документ)** — инфраструктура темы + полная переделка Дашборда + новый sidebar-shell + переключатель в Настройках.
- **Sub-projects 2-9** — поэтапная переделка остальных страниц. Каждый — со своей спекой и планом.

## Цель sub-project 1

Заменить старую light/dark тему на единственную тему `glass` с новым sidebar-layout. Дашборд должен быть полностью переделан под структуру preview с реальными данными. Остальные страницы получают новую палитру через CSS-токены и продолжают работать внутри нового layout-shell без визуальной переделки.

## Принятые решения (записаны на этапе brainstorming)

1. **Декомпозиция:** Дашборд + фундамент сейчас, остальные страницы отдельными sub-projects позже.
2. **Тёмная тема убирается полностью.** В системе остаётся одна тема `glass`. Кнопка `🌙` в шапке удаляется.
3. **Layout:** sidebar 220px на desktop, off-canvas drawer на <1024px.
4. **Содержимое Дашборда:** полная замена структуры под preview. Виджеты, которых нет в текущем дашборде, реализуются включая необходимые backend-эндпоинты.
5. **Подход:** замена (B) — чистый swap, без параллельных layout'ов.
6. **Недостающие endpoints** входят в объём этого sub-project.

## Архитектура файлов

### Изменяется

| Файл | Что меняется |
|---|---|
| `frontend/index.html` | Топбар (`<header>` со старой нав-таблейкой, `dmToggle`, `dmLabel`) удаляется. Появляется `<div class="aurora">` (4 orb'а) и shell `<div class="app"><aside class="side gl">…</aside><main class="main">…</main></div>`. Разметка `#page-dashboard` целиком переписывается под структуру preview. Все остальные `#page-*` остаются как есть. |
| `frontend/css/base.css` | Секция `[data-theme="dark"]` (текущие строки 10-15, 187-188, 210-211) удаляется. Корневой `:root` сохраняет имена токенов (`--bg`, `--card`, `--bd`, `--t1`, `--t2`, `--t3`, `--a`), но значения заменяются на cream/olive из preview — старые страницы получают новую палитру автоматически. |
| `frontend/js/core/theme.js` | Переписан: `initTheme()` + `setTheme(name)` + `getTheme()`. Применяет атрибут `data-theme="glass"` на `<html>` и сохраняет в `localStorage.lp_theme`. Старые `initDarkMode/toggleDarkMode/updateDmLabel` удаляются. |
| `frontend/js/pages/dashboard.js` | Переписан под новые виджеты (4 metric с sparkline, line chart, топ услуг, donut сегментов, сегодня в зале, лента бонусов). Сохраняет существующий механизм `cascadeCards` и `animateCount`. |
| `frontend/js/pages/settings.js` | Добавляется секция «Внешний вид» — рендер selector'а тем + handler выбора. ~80 строк дополнительно. |
| `backend/routes/dashboard.js` (или там где живёт текущая dashboard-стата) | Расширяется агрегатом `visits` за период (count записей с `attendance ∈ (1,2)`). Точное местоположение определяется в плане. |

### Новое

| Файл | Назначение |
|---|---|
| `frontend/css/glass.css` | Все glass-специфичные стили: aurora-orbs + анимации, sidebar layout + drawer, `.gl` карточки (blur + hairline + sheen), hero, metric cards, chart-wrap, donut, upcoming-row, feed. Подключается в `index.html` после `base.css`. |
| `backend/routes/loyalty.js` (новый endpoint) | `GET /api/loyalty/feed?limit=N` — последние N операций по программе лояльности (тип, клиент, услуга, сумма, timestamp). Используется виджетом «Лента бонусов». |

### Удаляется

- HTML-разметка кнопки `#dmToggle` и `#dmLabel` в шапке `index.html` (~5 строк).

### Хранилище

- Ключ `localStorage.lp_dark` мигрируется → удаляется. Создаётся `localStorage.lp_theme = 'glass'`.
- Опционально: `localStorage.lp_reduce_motion` (boolean) — управляется чекбоксом в Настройках, default = system `prefers-reduced-motion`.

## Layout shell

### Desktop (≥1024px)

```html
<div class="aurora" aria-hidden="true">
  <div class="orb lime"></div>
  <div class="orb sage"></div>
  <div class="orb cream"></div>
  <div class="orb faint"></div>
</div>
<div class="app">
  <aside class="side gl">
    <div class="brand">…loyal.pro</div>
    <nav class="nav">…главное</nav>
    <nav class="nav">…сервис</nav>
    <div class="side-foot">…user-chip</div>
  </aside>
  <main class="main">
    <div class="topbar">…breadcrumbs + actions</div>
    <div class="page active" id="page-dashboard">…</div>
    <div class="page" id="page-clients">…</div>
    …
  </main>
</div>
```

- `.side` — `position: sticky; top: 0; height: 100vh; width: 220px; flex: 0 0 220px`. Backdrop-filter blur активен.
- `.main` — `flex: 1; min-width: 0; padding: …`.
- Active item в sidebar отслеживается роутером в `app.js` — добавляется/убирается класс `.active` при смене страницы.
- Z-index: `.aurora { z-index: 0 }`, `.app { position: relative; z-index: 1 }`. Контент всегда над orbs.

### Tablet/mobile (<1024px)

- Sidebar получает `transform: translateX(-100%); transition: transform .3s`.
- В `.topbar` появляется burger-кнопка (показывается через media query `display: none` → `display: flex` на <1024px).
- Клик на burger → `body.classList.add('drawer-open')` → sidebar `transform: translateX(0)` + полупрозрачный overlay `<div class="drawer-overlay">` перекрывает main.
- Клик по overlay, по любой ссылке навигации, или нажатие `Esc` → `drawer-open` снимается.
- Когда drawer открыт — focus-trap внутри sidebar (для accessibility).

### Aurora

- 4 orb'а с `position: absolute; border-radius: 50%; filter: blur(90px); will-change: transform; pointer-events: none`.
- Анимации `drift1..drift4` 24-30s ease-in-out infinite, разные translate-вектора.
- `@media (prefers-reduced-motion: reduce)` — `animation: none` на всех orbs (статичные пятна остаются).
- Класс `.no-motion` на `<html>` (управляется чекбоксом в Настройках) — также отключает анимации, независимо от system prefs.

## Dashboard — структура и данные

Markup переписан под preview, привязан к существующим API (с двумя новыми endpoints).

### Hero

- Приветствие «доброе утро/день/вечер, [имя]» — из `req.user.name`, время суток вычисляется на клиенте.
- Подзаголовок — динамическая сводка вида «N записей, M новых клиентов подключили карту, выручка опережает прошлую неделю на K%». Значения из тех же metric endpoints, формат строки фиксирован.
- Переключатель периода (`день / 7 дней / 30 дней / год`) — единый для всех виджетов. Default = «7 дней». Состояние — JS-переменная без localStorage; смена периода триггерит re-render всех виджетов.

### 4 metric-карточки

| Карточка | Источник |
|---|---|
| **Выручка** | существующий `revenue` за период + delta vs прошлый период |
| **Визиты** | новый агрегат: `COUNT(records) WHERE attendance ∈ (1,2)` за период. Расширение существующего dashboard-stat endpoint |
| **Средний чек** | существующее `an1` |
| **Бонусы** | существующее `an2` (начислено), подзаголовок — `an5` (списано) |

Каждая карточка:
- `.m-label` (название), `.m-icon` (svg), `.m-value` (число), `.m-foot` (delta + note), `.m-spark` (SVG line chart 88×30 из 7-8 точек).
- Sparkline-данные — массив из 7 значений за период из timeseries endpoint.

### «Денежный поток»

- Line chart 600×240 SVG. Три линии:
  - **Выручка** — толстая `#1b2710`, под ней gradient-fill.
  - **Начислено** — тонкая `#6b8c3a`.
  - **Списано** — тонкая `#b89868` пунктиром (`stroke-dasharray: 2 4`).
- Highlight-точка на максимуме периода + tooltip-rect (день + сумма).
- Сетка из 4 horizontal grid-lines + axis labels по дням периода.
- Данные: timeseries за период из dashboard endpoint. Если timeseries отсутствует в текущем endpoint — добавляется (детали в плане).

### «Топ услуг»

- 5 строк: название услуги / специалисты / средний чек / общая сумма / count + прогресс-бар.
- Данные: существующий top-services endpoint (см. `renderSvcTable` в `dashboard.js:65-85`).
- Сортировка по сумме, top 5.

### «Сегменты клиентов»

- Donut SVG (5 слайсов): VIP / Постоянные / Новички / Уходят / Прочие.
- Центр donut: общее число клиентов.
- Список справа: dot + название + count для каждого сегмента.
- Данные: `/api/segments` — там уже есть распределение клиентов по сегментам. Если структура не совпадает — добавляется агрегат `counts` в response.

### «Сегодня в зале»

- 5 ближайших записей на сегодня: time-tag + имя клиента + услуга + специалист.
- time-tag «сейчас» подсвечивается lime-фоном.
- Данные: `GET /api/records?date=today&limit=5&order=time_asc`. Если фильтр `date=today` отсутствует — добавляется параметр в существующий endpoint.

### «Лента бонусов» (full-width)

- 4 последние операции: иконка типа (up/down/warm) + имя клиента + текст операции + сумма.
- Типы: начисление за визит (up), списание (down), день рождения (warm), реферальный (up).
- Данные: новый endpoint `GET /api/loyalty/feed?limit=4`. Реализация: `SELECT * FROM loyalty_transactions WHERE salon_id=$1 ORDER BY created_at DESC LIMIT $2`. Точное имя таблицы и полей уточняется на этапе плана (вероятно `bonus_transactions` или похожая таблица — см. `services/loyalty.js`).

## Settings → Внешний вид

### Sidebar страницы Настройки

Новая группа после «🏆 Лояльность», перед «⚙️ Salon»:

```
🎨 Интерфейс
  └ data-sec="appearance" → 🎨 Внешний вид
```

### Содержимое секции `#stg-appearance`

- Заголовок «Тема оформления».
- Подзаголовок «Выберите внешний вид интерфейса».
- Список тем (radio-карточки):
  - **Glass** (выбрана, единственная сейчас) — мини-палитра 80×60 (cream + lime + olive прямоугольники) + название + описание «Cream + olive, glassmorphism».
  - Карточка-заглушка «Скоро» с подписью «новые темы появятся в следующих обновлениях».
- Чекбокс «Уменьшить анимации» — toggle класса `.no-motion` на `<html>`, persist в `localStorage.lp_reduce_motion`.

### Поведение

- Клик radio → `setTheme('glass')`. На один-вариантной странице это no-op, но архитектура готова.
- Изменение чекбокса → toggle класса + persist.

### Реализация

- ~50 строк HTML в `index.html` (внутри `#page-settings`).
- ~30 строк JS в `settings.js` (handler выбора темы + чекбокса).
- CSS-карточек переиспользуем существующие patterns (`.stg-section`, `.fg`, `.fl`, `.btn-pri`).

## Миграция и edge cases

### Миграция существующих пользователей

В `theme.js → initTheme()`:

```js
function initTheme() {
  if (localStorage.getItem('lp_dark') !== null && !localStorage.getItem('lp_theme')) {
    localStorage.removeItem('lp_dark');
    localStorage.setItem('lp_theme', 'glass');
  }
  const theme = localStorage.getItem('lp_theme') || 'glass';
  document.documentElement.setAttribute('data-theme', theme);
  if (localStorage.getItem('lp_reduce_motion') === '1') {
    document.documentElement.classList.add('no-motion');
  }
}
```

Никаких тостов или onboarding'а — пользователи увидят новый интерфейс молча.

### Default

- `lp_theme` отсутствует → ставим `'glass'`.
- Атрибут `data-theme="glass"` всегда присутствует на `<html>` — `glass.css` пишется под селектор `[data-theme="glass"]`, никаких fallback'ов без атрибута.

### Performance

- Aurora-orbs: 4 элемента с `filter: blur(90px)` на `position:fixed`. Composited GPU-layer, прозрачно для CPU. `prefers-reduced-motion: reduce` или `.no-motion` отключает `animation`.
- `backdrop-filter: blur()` применяется только к крупным контейнерам: `.side`, `.topbar`, `.gl` карточки, hero, metric. **НЕ применяется** к строкам таблиц, элементам списков, мелким иконкам — это критично для data-heavy страниц (Клиенты, Записи).
- Fallback для браузеров без `backdrop-filter`:
  ```css
  @supports not (backdrop-filter: blur(20px)) {
    .gl { background: rgba(252,252,248,.92); }
  }
  ```

### Доступность

- Контраст: `--ink #1b2710` на `--cream #fcfcf8` ≈ 14:1 (AAA). `--ink-3 #7a8475` на cream ≈ 4.6:1 (AA для normal).
- Sidebar drawer: focus-trap при открытии, закрытие по `Esc`.
- Aurora: `aria-hidden="true"` на контейнере.
- Все интерактивные элементы sidebar доступны клавиатурой (`Tab`).

### Браузерная совместимость

- Целевая поддержка: Safari 14+, Chrome 90+, Firefox 90+, Edge 90+.
- Префикс `-webkit-backdrop-filter` параллельно `backdrop-filter` для Safari.
- IE11 не поддерживается (его нет в текущем SPA).

### Smoke-test остальных страниц

После замены layout-shell все страницы (Клиенты, Записи, Сегменты, Сотрудники, Домашний уход, Портфолио, Настройки, Пользователи) оказываются внутри новой `<main class="main">` обёртки. Их собственные стили не должны конфликтовать, но обязателен ручной smoke-test каждой:

1. Открыть страницу
2. Проверить что не разъехалось: таблицы помещаются по ширине, модалки открываются, нет горизонтального скролла.
3. Зафиксировать в plan'е как acceptance-criteria.

## Out of scope

- Глубокая перевёрстка остальных 8 страниц под glass-эстетику (Клиенты, Записи, Сегменты, Сотрудники, Домашний уход, Портфолио, Настройки-визуал, Пользователи). Они получают только новую палитру через CSS-токены и работают внутри sidebar-shell. Полная переделка каждой = отдельный sub-project (2-9).
- Несколько тем. UI селектора готов к расширению, но в этом sub-project существует только `glass`.
- Темизация мобильного приложения (Expo).
- Темизация писем/PDF/шаблонов «Домашний уход» — серверный рендер, отдельная работа.
- Анимации появления виджетов, parallax, scroll-triggered эффекты. Только то, что есть в preview (sheen-by-cursor + period-toggle).
- Кастомизация цветов салоном (white-label).
- i18n темы.
- A/B-роллаут / feature flag — деплой включает glass для всех салонов сразу.

## Definition of Done

1. Открыв `/` (после логина), пользователь видит sidebar слева, главная страница — Дашборд в glass-стилистике (4 metric + чарт + топ услуг + сегменты + сегодня в зале + лента бонусов), все цифры реальные.
2. Все 9 страниц навигации открываются и не сломаны (smoke-test пройден).
3. Sidebar превращается в drawer на ширине <1024px, открывается burger-кнопкой, закрывается по overlay/Esc.
4. Настройки → Интерфейс → Внешний вид существует, показывает radio-карточку «Glass» (selected) + чекбокс «Уменьшить анимации».
5. Кнопка `🌙` в шапке отсутствует.
6. Существующие пользователи с `lp_dark='1'` входят в систему — миграция в `glass` происходит без ошибок, видят новую тему.
7. Backend-эндпоинты `GET /api/loyalty/feed?limit=N` и расширение dashboard-stat на `visits` существуют, отдают валидные данные, scoped к `req.user.salon_id`.
8. Aurora-orbs анимируются на desktop, останавливаются при `prefers-reduced-motion: reduce` или включённом чекбоксе «Уменьшить анимации».
9. Browser smoke-test: Chrome последний + Safari последний — Дашборд рендерится без layout-bugs.
