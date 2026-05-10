# Glass Theme Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing light/dark themes with a single switchable `glass` theme (cream + olive palette, glassmorphism, sidebar layout) and rebuild the Dashboard under the structure of `frontend/glass-preview.html`. Drop dark mode. Add an "Внешний вид" selector in Settings.

**Architecture:** Frontend-only sub-project. The existing `/api/analytics/dashboard` already returns all the data needed for new widgets (`stats`, `topServices`, `dailyRevenue`, `recentTxns`); `/api/segments` returns segment counts; `/api/records?dateFrom&dateTo` is reused for "сегодня в зале". Layout shell becomes `<aside class="side"> + <main class="main">` instead of the current `<header>` topbar, with off-canvas drawer on <1024px. CSS uses two layers: existing `base.css` keeps token names but swaps values to cream/olive (so untouched pages get the new palette automatically); a new `glass.css` adds aurora orbs, sidebar styles, `.gl` glass-card mixin (blur + hairline + sheen), Dashboard widget styles.

**Tech Stack:** Vanilla JS SPA (no framework), CSS custom properties, SVG charts. Tests: simple Node scripts for pure logic (mirroring existing `clients-api.test.js` pattern), Playwright MCP (`mcp__playwright__*`) for E2E smoke tests against the running dev server (`pm2 start ecosystem.config.js` → `http://localhost:3001`).

**Spec deviation:** During exploration of `backend/routes/api.js` we discovered the dashboard endpoint already returns `recentTxns` and `dailyRevenue` series, and `/api/records` already accepts `dateFrom`/`dateTo`. The spec assumed a new `/api/loyalty/feed` endpoint and a `visits` aggregate would be needed; they are not. **No backend work in this plan.**

---

## File Structure

### Created
- `frontend/css/glass.css` — aurora-orbs + animations, sidebar/main shell, `.gl` mixin, sheen-by-cursor, hero, metric, chart, donut, upcoming, feed. Ships under `[data-theme="glass"]` selector exclusively.
- `frontend/js/pages/dashboard-glass.js` — net-new render functions for new widgets (period switcher, hero, sparkline, donut, upcoming, feed). Existing `dashboard.js` is mostly replaced; we keep it as the file but its body is rewritten.
- `frontend/tests/theme-migration.test.js` — Node test for `theme.js` migration logic.
- `frontend/tests/dashboard-formatters.test.js` — Node test for hero subtitle and feed-type-classification formatters.

### Modified
- `frontend/index.html` — header (`<div class="topbar">…`) deleted; aurora + app-shell wrapper added; `#page-dashboard` markup fully rewritten; new "🎨 Интерфейс" group + `#stg-appearance` section in settings page; `dmToggle`/`dmLabel` removed.
- `frontend/css/base.css` — `:root` palette values swapped (token names retained); all `[data-theme="dark"]` rules deleted; `.tn` class rules become legacy/unused (left for now if any other code references them, but not used by new sidebar).
- `frontend/js/core/theme.js` — fully rewritten as `initTheme/setTheme/getTheme` + `lp_dark` migration + `lp_reduce_motion` toggle.
- `frontend/js/core/nav.js` — `nav()` rewritten to use `.nav-a` (sidebar links) instead of `.tn`; `applyRoleNav` updated; `launchApp` updated to populate sidebar user-chip instead of removed top-nav avatar.
- `frontend/js/pages/dashboard.js` — body rewritten. Old top-services table removed in favour of new "Топ услуг" widget.
- `frontend/js/pages/settings.js` — `loadSettings()` extended to render appearance section state (theme radio, reduce-motion checkbox).

### Deleted
None permanently. Dark-theme rules are physically removed from `base.css`. The `dmToggle` button is removed from `index.html`.

---

## Phase 1 — Theme infrastructure

### Task 1: Rewrite `theme.js` with migration + setTheme API

**Files:**
- Modify: `frontend/js/core/theme.js` (full rewrite)
- Create: `frontend/tests/theme-migration.test.js`

- [ ] **Step 1: Write the failing test**

```js
// frontend/tests/theme-migration.test.js
const assert = require('assert');

function setupDom(localStorageData) {
  global.localStorage = {
    _d: { ...localStorageData },
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
  };
  global.document = {
    documentElement: {
      _attrs: {}, _classes: new Set(),
      setAttribute(k, v) { this._attrs[k] = v; },
      getAttribute(k) { return this._attrs[k] || null; },
      removeAttribute(k) { delete this._attrs[k]; },
      classList: { add(c) { document.documentElement._classes.add(c); }, remove(c) { document.documentElement._classes.delete(c); }, contains(c) { return document.documentElement._classes.has(c); } },
    },
  };
}

function loadTheme() {
  delete require.cache[require.resolve('../js/core/theme.js')];
  // theme.js calls initTheme() at bottom; we just require it.
  require('../js/core/theme.js');
  return { setTheme: global.setTheme, getTheme: global.getTheme, initTheme: global.initTheme };
}

// Test 1: Fresh user (no keys) → glass default
setupDom({});
loadTheme();
assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'glass', 'fresh user should get glass theme');
assert.strictEqual(localStorage.getItem('lp_theme'), 'glass', 'fresh user should have lp_theme persisted');

// Test 2: Existing user with lp_dark='1' → migrated to glass
setupDom({ lp_dark: '1' });
loadTheme();
assert.strictEqual(localStorage.getItem('lp_dark'), null, 'lp_dark should be removed');
assert.strictEqual(localStorage.getItem('lp_theme'), 'glass', 'lp_theme should be set to glass');
assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'glass');

// Test 3: Existing user with lp_dark='0' → migrated to glass
setupDom({ lp_dark: '0' });
loadTheme();
assert.strictEqual(localStorage.getItem('lp_dark'), null);
assert.strictEqual(localStorage.getItem('lp_theme'), 'glass');

// Test 4: Already migrated (lp_theme='glass', no lp_dark) → no-op
setupDom({ lp_theme: 'glass' });
loadTheme();
assert.strictEqual(localStorage.getItem('lp_theme'), 'glass');

// Test 5: setTheme persists and applies
setupDom({});
const api = loadTheme();
api.setTheme('glass');
assert.strictEqual(localStorage.getItem('lp_theme'), 'glass');
assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'glass');

console.log('theme-migration.test: all 5 assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node tests/theme-migration.test.js`
Expected: FAIL with something like `TypeError: Cannot read properties of undefined (reading 'setTheme')` (because theme.js doesn't yet export setTheme/getTheme/initTheme as globals).

- [ ] **Step 3: Rewrite `theme.js`**

```js
// frontend/js/core/theme.js
// ── THEME ────────────────────────────────────────────────────
const LP_THEME_KEY = 'lp_theme';
const LP_DARK_LEGACY_KEY = 'lp_dark';
const LP_REDUCE_MOTION_KEY = 'lp_reduce_motion';
const DEFAULT_THEME = 'glass';

function initTheme() {
  // One-time migration: drop legacy lp_dark, force glass.
  if (localStorage.getItem(LP_DARK_LEGACY_KEY) !== null && !localStorage.getItem(LP_THEME_KEY)) {
    localStorage.removeItem(LP_DARK_LEGACY_KEY);
    localStorage.setItem(LP_THEME_KEY, DEFAULT_THEME);
  }
  let theme = localStorage.getItem(LP_THEME_KEY);
  if (!theme) {
    theme = DEFAULT_THEME;
    localStorage.setItem(LP_THEME_KEY, theme);
  }
  document.documentElement.setAttribute('data-theme', theme);

  if (localStorage.getItem(LP_REDUCE_MOTION_KEY) === '1') {
    document.documentElement.classList.add('no-motion');
  }
}

function setTheme(name) {
  if (name !== 'glass') return; // future-extensible; only glass is valid today
  localStorage.setItem(LP_THEME_KEY, name);
  document.documentElement.setAttribute('data-theme', name);
}

function getTheme() {
  return localStorage.getItem(LP_THEME_KEY) || DEFAULT_THEME;
}

function setReduceMotion(on) {
  if (on) {
    localStorage.setItem(LP_REDUCE_MOTION_KEY, '1');
    document.documentElement.classList.add('no-motion');
  } else {
    localStorage.removeItem(LP_REDUCE_MOTION_KEY);
    document.documentElement.classList.remove('no-motion');
  }
}

initTheme();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && node tests/theme-migration.test.js`
Expected: `theme-migration.test: all 5 assertions passed`

- [ ] **Step 5: Commit**

```bash
git add frontend/js/core/theme.js frontend/tests/theme-migration.test.js
git commit -m "feat(theme): rewrite theme.js as setTheme API with lp_dark→glass migration"
```

---

### Task 2: Replace `base.css` palette tokens; drop dark theme rules

**Files:**
- Modify: `frontend/css/base.css:1-15, 187-188, 210-211`

- [ ] **Step 1: Read current `:root` and dark-theme rules**

Run: `head -20 frontend/css/base.css` and `grep -n 'data-theme' frontend/css/base.css`
Expected: see existing tokens (`--bg #f6f8fa`, etc.) and three `[data-theme="dark"]` blocks.

- [ ] **Step 2: Rewrite `:root` block (lines 1-9 in base.css)**

Replace the existing `:root { … }` block with the cream/olive palette below (token names preserved so all existing pages keep working):

```css
:root{
  /* base palette — cream/olive (formerly grayscale) */
  --bg:#fcfcf8;          /* page background — cream */
  --card:#ffffff;        /* solid card surface (when blur not used) */
  --bd:rgba(27,39,16,.10);  /* hairline borders */
  --t1:#1b2710;          /* primary text — deep olive */
  --t2:#3d4a36;          /* secondary text */
  --t3:#7a8475;          /* tertiary text */
  --a:#6b8c3a;           /* accent — moss */
  --a-warm:#b89868;      /* warm accent — champagne */
  --danger:#a14a3a;      /* red shifted toward terracotta to fit palette */
  --warn:#b89868;
  --ok:#6b8c3a;

  /* glass-specific tokens (consumed by glass.css) */
  --olive:#1b2710;
  --olive-2:#3d4a2b;
  --olive-3:#6b8c3a;
  --lime:#d3fa99;
  --lime-d:#b8e070;
  --sage:#dde2d4;
  --mint:#cdd9c4;
  --cream:#fcfcf8;
  --cream-warm:#f4f3ec;
  --sand:#eae7dc;
  --champagne:#b89868;
  --ink:#1b2710;
  --ink-2:#3d4a36;
  --ink-3:#7a8475;
  --ink-4:#b3b9af;
  --hairline:rgba(255,255,255,.72);
  --hairline-d:rgba(27,39,16,.07);
  --glass:rgba(252,252,248,.5);
  --glass-strong:rgba(252,252,248,.7);
  --shadow-glass:
    0 1px 0 rgba(255,255,255,.96) inset,
    0 -1px 0 rgba(255,255,255,.18) inset,
    0 0 0 .5px rgba(27,39,16,.04),
    0 24px 50px -22px rgba(27,39,16,.12),
    0 8px 22px -8px rgba(27,39,16,.06);
  --radius-xl:28px;
  --radius-lg:20px;
  --radius-md:14px;
}
```

- [ ] **Step 3: Delete dark-theme rules**

Delete these blocks from `base.css` (use Edit with the exact text from each location):

1. Lines ~10-15 (`[data-theme="dark"]{ --bg:#0d1117; … }`) — delete entire block.
2. Lines ~187-188 (`[data-theme="dark"] .sc { … }` and `[data-theme="dark"] .card { … }`) — delete both rules.
3. Lines ~210-211 (`[data-theme="dark"] .dm-btn { … }` and `[data-theme="dark"] .dm-btn::after { … }`) — delete both rules.

- [ ] **Step 4: Verify CSS still parses**

Run: `node -e "const fs=require('fs'); const css=fs.readFileSync('frontend/css/base.css','utf8'); const opens=(css.match(/{/g)||[]).length; const closes=(css.match(/}/g)||[]).length; console.log('braces',opens,closes); if(opens!==closes) process.exit(1)"`
Expected: `braces N N` (equal counts), exit 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/css/base.css
git commit -m "feat(theme): swap base.css palette to cream/olive, drop dark theme rules"
```

---

### Task 3: Create `glass.css` scaffold (aurora + reset + utility)

**Files:**
- Create: `frontend/css/glass.css`
- Modify: `frontend/index.html` (add `<link>` after `base.css`)

- [ ] **Step 1: Create `glass.css` with aurora and base utilities**

Create `frontend/css/glass.css`:

```css
/* ── glass.css — applied only under [data-theme="glass"] ────── */

[data-theme="glass"] body {
  background:
    radial-gradient(ellipse 90% 70% at 50% 100%, #fffef7 0%, transparent 60%),
    linear-gradient(180deg, #fcfcf8 0%, #f5f4ee 100%);
  min-height: 100vh;
  letter-spacing: -.005em;
  font-weight: 400;
}

/* ── Aurora ─────────────────────────────────────────────────── */
[data-theme="glass"] .aurora {
  position: fixed; inset: 0; z-index: 0;
  pointer-events: none; overflow: hidden;
}
[data-theme="glass"] .aurora .orb {
  position: absolute; border-radius: 50%;
  filter: blur(90px); will-change: transform;
}
[data-theme="glass"] .aurora .orb.lime {
  width: 760px; height: 760px; left: -220px; top: -240px;
  background: radial-gradient(circle, #d3fa99 0%, #d3fa99 22%, transparent 70%);
  opacity: .32;
  animation: aurora-drift1 24s ease-in-out infinite;
}
[data-theme="glass"] .aurora .orb.sage {
  width: 720px; height: 720px; right: -220px; top: -180px;
  background: radial-gradient(circle, #cdd9c4 0%, #cdd9c4 26%, transparent 70%);
  opacity: .5;
  animation: aurora-drift2 26s ease-in-out infinite;
}
[data-theme="glass"] .aurora .orb.cream {
  width: 640px; height: 640px; left: 32%; bottom: -180px;
  background: radial-gradient(circle, #f4f3ec 0%, #f4f3ec 30%, transparent 70%);
  opacity: .85;
  animation: aurora-drift3 28s ease-in-out infinite;
}
[data-theme="glass"] .aurora .orb.faint {
  width: 480px; height: 480px; right: 22%; bottom: -120px;
  background: radial-gradient(circle, #dde2d4 0%, #dde2d4 28%, transparent 70%);
  opacity: .5;
  animation: aurora-drift4 30s ease-in-out infinite;
}
@keyframes aurora-drift1 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(100px,70px) scale(1.1); } }
@keyframes aurora-drift2 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-80px,90px) scale(1.06); } }
@keyframes aurora-drift3 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(60px,-50px) scale(1.04); } }
@keyframes aurora-drift4 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-40px,-60px) scale(1.08); } }

@media (prefers-reduced-motion: reduce) {
  [data-theme="glass"] .aurora .orb { animation: none !important; }
}
[data-theme="glass"].no-motion .aurora .orb,
.no-motion[data-theme="glass"] .aurora .orb { animation: none !important; }
```

- [ ] **Step 2: Wire `glass.css` into `index.html`**

Find the existing `<link rel="stylesheet" href="css/base.css">` line in `index.html` (likely in the `<head>`). Add immediately after it:

```html
<link rel="stylesheet" href="css/glass.css">
```

- [ ] **Step 3: Manual smoke check**

Run: `pm2 restart loyalpro` (or ensure dev server is running on :3001), then:
- Open `http://localhost:3001/` in browser.
- Site should still render (palette now cream/olive on existing topbar layout).
- `glass.css` is loaded (DevTools Network) but its rules don't trigger yet (no `data-theme="glass"` on `<html>`? — actually, `theme.js` now sets `data-theme="glass"` on init, so aurora-orb container will be empty/absent until Task 5; CSS is harmless).
- No JS console errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/css/glass.css frontend/index.html
git commit -m "feat(theme): add glass.css with aurora-orbs scaffold, wire into index.html"
```

---

## Phase 2 — Layout shell

### Task 4: Add aurora HTML + glass-card mixin (`.gl`) + sheen-by-cursor

**Files:**
- Modify: `frontend/index.html` (insert `<div class="aurora">…` near `<body>` start)
- Modify: `frontend/css/glass.css` (append `.gl` mixin + sheen JS-driven gradient)
- Modify: `frontend/index.html` `<script>` block (add sheen mousemove handler)

- [ ] **Step 1: Insert `.aurora` block right after `<body>`**

Add this to `index.html` immediately after the opening `<body>` tag:

```html
<div class="aurora" aria-hidden="true">
  <div class="orb lime"></div>
  <div class="orb sage"></div>
  <div class="orb cream"></div>
  <div class="orb faint"></div>
</div>
```

- [ ] **Step 2: Append `.gl` glass-card mixin to `glass.css`**

Append to `frontend/css/glass.css`:

```css
/* ── glass-card mixin ─────────────────────────────────────── */
[data-theme="glass"] .gl {
  position: relative;
  background: var(--glass);
  -webkit-backdrop-filter: blur(20px) saturate(140%);
  backdrop-filter: blur(20px) saturate(140%);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-glass);
  overflow: hidden;
}
[data-theme="glass"] .gl::before {
  content: '';
  position: absolute; inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background:
    radial-gradient(circle at var(--mx,50%) var(--my,50%),
                    rgba(255,255,255,.42) 0%,
                    transparent 45%);
  opacity: 0;
  transition: opacity .25s ease;
}
[data-theme="glass"] .gl:hover::before { opacity: 1; }

@supports not ((-webkit-backdrop-filter: blur(20px)) or (backdrop-filter: blur(20px))) {
  [data-theme="glass"] .gl { background: rgba(252,252,248,.92); }
}
```

- [ ] **Step 3: Add sheen mousemove handler in `index.html` `<script>` (or `frontend/js/app.js`)**

Locate the existing `<script>` block at the end of `index.html` (or `js/app.js`). Append:

```js
document.addEventListener('mousemove', (e) => {
  const el = e.target.closest && e.target.closest('.gl');
  if (!el) return;
  const r = el.getBoundingClientRect();
  el.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
  el.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
}, { passive: true });
```

- [ ] **Step 4: Smoke check**

Reload `http://localhost:3001/`. Open DevTools Console — no errors. Aurora orbs should be visible animating in the background of the (still-current) topbar UI. (`.gl` not yet applied to anything visible.)

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/css/glass.css
git commit -m "feat(theme): aurora-orbs in DOM, .gl mixin with sheen-by-cursor"
```

---

### Task 5: Restructure `index.html` into app/side/main shell + sidebar styles

**Files:**
- Modify: `frontend/index.html` — delete `<header>` topbar, wrap pages in `<div class="app"><aside class="side gl">…</aside><main class="main">…</main></div>`
- Modify: `frontend/css/glass.css` — sidebar + main + topbar-of-main + breadcrumbs + nav-section + side-foot styles
- Modify: `frontend/js/core/nav.js` — `nav()` and `applyRoleNav` use `.nav-a` selector instead of `.tn`
- Modify: `frontend/js/core/nav.js → launchApp()` — populate sidebar user-chip elements

- [ ] **Step 1: Replace topbar markup with sidebar shell**

Delete the existing `<header>` block in `index.html` (containing `#mainNav`, `dmToggle`, `topAv`, `topName`, `syncBtn`, logout button — roughly lines 80-105). Replace with:

```html
<div class="app" id="app" style="display:none">

  <aside class="side gl" id="mainNav">
    <div class="brand">
      <div class="brand-mark">L</div>
      <div class="brand-name">loyal<em>.pro</em></div>
    </div>

    <div class="nav-section">главное</div>
    <nav class="nav">
      <a class="nav-a active" data-p="dashboard"        data-roles="owner,admin"            onclick="nav(this); return false" href="#dashboard"><span class="nav-ic">📊</span>Дашборд</a>
      <a class="nav-a"        data-p="clients"          data-roles="owner,admin"            onclick="nav(this); return false" href="#clients"><span class="nav-ic">👥</span>Клиенты</a>
      <a class="nav-a"        data-p="records"          data-roles="owner,admin"            onclick="nav(this); return false" href="#records"><span class="nav-ic">📅</span>Записи</a>
      <a class="nav-a"        data-p="segments"         data-roles="owner,admin"            onclick="nav(this); return false" href="#segments"><span class="nav-ic">📈</span>Сегменты</a>
      <a class="nav-a"        data-p="staff-analytics"  data-roles="owner,admin"            onclick="nav(this); return false" href="#staff"><span class="nav-ic">✂️</span>Сотрудники</a>
    </nav>

    <div class="nav-section">сервис</div>
    <nav class="nav">
      <a class="nav-a"        data-p="home-care"        data-roles="owner,admin,specialist" onclick="nav(this); return false" href="#home-care"><span class="nav-ic">🏠</span>Уход</a>
      <a class="nav-a"        data-p="settings"         data-roles="owner,admin"            onclick="nav(this); return false" href="#settings"><span class="nav-ic">⚙️</span>Настройки</a>
      <a class="nav-a"        data-p="users"            data-roles="owner"                  onclick="nav(this); return false" href="#users"><span class="nav-ic">🔐</span>Пользователи</a>
    </nav>

    <div class="side-foot">
      <button class="icon-btn gl" id="syncBtn" onclick="triggerSync()" title="Синхронизация">↻</button>
      <button class="icon-btn gl" onclick="doLogout()" title="Выйти">⏏</button>
      <div class="user-chip">
        <div class="user-ava" id="topAv">?</div>
        <div>
          <div class="user-name" id="topName">—</div>
          <div class="user-role" id="topRole"></div>
        </div>
      </div>
    </div>
  </aside>

  <main class="main">

    <div class="topbar">
      <button class="burger" id="navBurger" aria-label="Меню" onclick="toggleDrawer()">☰</button>
      <div class="crumbs">
        <strong id="crumbTitle">Дашборд</strong>
      </div>
      <div class="top-actions">
        <!-- intentionally empty for now; search/notifications come later -->
      </div>
    </div>

    <!-- ALL existing <div class="page" id="page-…">…</div> blocks move here, unchanged -->

  </main>

  <div class="drawer-overlay" id="drawerOverlay" onclick="toggleDrawer(false)"></div>
</div>
```

Then move all existing `<div class="page" id="page-…">…</div>` blocks (currently siblings of the deleted `<header>`) so they live inside `<main class="main">`.

Important: keep `id="app"` on the outer wrapper so `launchApp()` (which does `getElementById('app').style.display = 'flex'`) keeps working.

- [ ] **Step 2: Append sidebar styles to `glass.css`**

```css
/* ── App shell + sidebar ──────────────────────────────────── */
[data-theme="glass"] .app {
  position: relative; z-index: 1;
  display: flex; min-height: 100vh;
}
[data-theme="glass"] .side {
  position: sticky; top: 0;
  flex: 0 0 220px; width: 220px; height: 100vh;
  padding: 18px 14px; display: flex; flex-direction: column; gap: 6px;
  border-right: 1px solid var(--hairline-d);
  border-radius: 0;
}
[data-theme="glass"] .brand {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 8px 18px;
}
[data-theme="glass"] .brand-mark {
  width: 28px; height: 28px; border-radius: 8px;
  background: linear-gradient(135deg, #1b2710, #3d4a2b);
  color: #d3fa99; display: flex; align-items: center; justify-content: center;
  font-weight: 600; font-size: 14px;
}
[data-theme="glass"] .brand-name { font-size: 16px; font-weight: 500; color: var(--ink); letter-spacing: -.01em; }
[data-theme="glass"] .brand-name em { font-style: normal; color: var(--ink-3); }

[data-theme="glass"] .nav-section {
  padding: 10px 10px 4px; font-size: 10px; letter-spacing: .14em;
  text-transform: uppercase; color: var(--ink-3);
}
[data-theme="glass"] .nav { display: flex; flex-direction: column; gap: 1px; }
[data-theme="glass"] .nav-a {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; border-radius: 10px;
  color: var(--ink-2); font-size: 13px; font-weight: 450;
  text-decoration: none; cursor: pointer;
  transition: background .15s, color .15s;
}
[data-theme="glass"] .nav-a:hover { background: rgba(27,39,16,.05); color: var(--ink); }
[data-theme="glass"] .nav-a.active { background: rgba(27,39,16,.92); color: #fcfcf8; }
[data-theme="glass"] .nav-a.active .nav-ic { filter: brightness(1.4) saturate(0); }
[data-theme="glass"] .nav-ic { width: 18px; display: inline-flex; justify-content: center; font-size: 14px; opacity: .7; }

[data-theme="glass"] .side-foot {
  margin-top: auto; display: flex; flex-direction: column; gap: 8px;
  padding-top: 14px; border-top: 1px solid var(--hairline-d);
}
[data-theme="glass"] .user-chip {
  display: flex; align-items: center; gap: 10px;
  padding: 8px; border-radius: 12px;
}
[data-theme="glass"] .user-ava {
  width: 30px; height: 30px; border-radius: 9px;
  background: linear-gradient(135deg, #b8e070, #6b8c3a);
  color: #fcfcf8; display: flex; align-items: center; justify-content: center;
  font-weight: 600; font-size: 12px; text-transform: uppercase;
}
[data-theme="glass"] .user-name { font-size: 12px; color: var(--ink); }
[data-theme="glass"] .user-role { font-size: 10px; color: var(--ink-3); }
[data-theme="glass"] .icon-btn {
  width: 32px; height: 32px; border-radius: 10px; border: none; cursor: pointer;
  background: rgba(252,252,248,.7); color: var(--ink-2);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 14px;
}
[data-theme="glass"] .icon-btn:hover { background: rgba(252,252,248,.95); color: var(--ink); }

/* ── Main + topbar ────────────────────────────────────────── */
[data-theme="glass"] .main {
  flex: 1; min-width: 0;
  padding: 22px 28px 60px;
}
[data-theme="glass"] .topbar {
  display: flex; align-items: center; gap: 14px;
  padding: 4px 0 22px;
}
[data-theme="glass"] .crumbs strong { font-size: 13px; font-weight: 500; color: var(--ink); }
[data-theme="glass"] .burger { display: none; background: none; border: none; cursor: pointer; font-size: 18px; color: var(--ink); padding: 6px 10px; border-radius: 8px; }
[data-theme="glass"] .top-actions { margin-left: auto; display: flex; gap: 8px; }

/* ── Drawer (mobile) ──────────────────────────────────────── */
[data-theme="glass"] .drawer-overlay {
  display: none;
  position: fixed; inset: 0; z-index: 40;
  background: rgba(27,39,16,.35);
  -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px);
}
[data-theme="glass"].drawer-open .drawer-overlay { display: block; }

@media (max-width: 1024px) {
  [data-theme="glass"] .burger { display: inline-flex; }
  [data-theme="glass"] .side {
    position: fixed; left: 0; top: 0; z-index: 50;
    transform: translateX(-100%); transition: transform .28s ease;
    background: rgba(252,252,248,.96);
    border-right: 1px solid var(--hairline-d);
  }
  [data-theme="glass"].drawer-open .side { transform: translateX(0); }
  [data-theme="glass"] .main { padding: 16px 16px 60px; }
}
```

- [ ] **Step 3: Update `nav.js` selector and add drawer toggle**

Replace `frontend/js/core/nav.js` body. The change: `.tn` → `.nav-a`, add `toggleDrawer`, populate sidebar user-chip in `launchApp`, add `crumbTitle` update.

```js
// frontend/js/core/nav.js
const PAGE_TITLES = {
  dashboard: 'Дашборд', clients: 'Клиенты', records: 'Записи',
  'staff-analytics': 'Сотрудники', segments: 'Сегменты',
  'home-care': 'Домашний уход', settings: 'Настройки', users: 'Пользователи',
};

function nav(el) {
  document.querySelectorAll('.nav-a').forEach(n => n.classList.remove('active'));
  el.classList.add('active');
  const p = el.dataset.p;
  document.querySelectorAll('.page').forEach(x => { x.classList.remove('active', 'page-enter'); });
  const page = document.getElementById('page-' + p);
  if (page) {
    page.classList.add('active');
    void page.offsetWidth;
    page.classList.add('page-enter');
  }
  const crumb = document.getElementById('crumbTitle');
  if (crumb) crumb.textContent = PAGE_TITLES[p] || p;
  toggleDrawer(false);
  if (p === 'clients')         loadClients();
  if (p === 'records')         { setDefDates(); loadRecords(1); }
  if (p === 'staff-analytics') loadStaffAnalytics();
  if (p === 'segments')        loadSegments();
  if (p === 'home-care')       loadHomeCare();
  if (p === 'settings')        loadSettings();
  if (p === 'users')           loadUsers();
}

function applyRoleNav(role) {
  const navItems = document.querySelectorAll('#mainNav .nav-a');
  let firstVisible = null;
  navItems.forEach(item => {
    const roles = (item.dataset.roles || '').split(',').map(r => r.trim());
    if (roles.includes(role)) {
      item.style.display = '';
      if (!firstVisible) firstVisible = item;
    } else { item.style.display = 'none'; }
  });
  navItems.forEach(n => n.classList.remove('active'));
  if (firstVisible) firstVisible.classList.add('active');
  return firstVisible?.dataset?.p || 'home-care';
}

function navStg(id, el) {
  document.querySelectorAll('.stg-item').forEach(e => e.classList.remove('active'));
  if (el) el.classList.add('active');
  document.querySelectorAll('.stg-section').forEach(e => e.classList.remove('active'));
  const sec = document.getElementById('stg-' + id);
  if (sec) sec.classList.add('active');
  if (id === 'loyalty-services') loadSvcCb();
  if (id === 'loyalty-birthday') loadBdList();
  if (id === 'sync-logs') loadSyncLogs();
  if (id === 'app-settings') loadAppSettings();
  if (id === 'staff-profiles') loadStaffProfiles();
  if (id === 'appearance') loadAppearance();
}

function toggleDrawer(force) {
  const html = document.documentElement;
  const open = (typeof force === 'boolean') ? force : !html.classList.contains('drawer-open');
  html.classList.toggle('drawer-open', open);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.documentElement.classList.contains('drawer-open')) toggleDrawer(false);
});

async function launchApp() {
  if (!ME) {
    try { ME = await api('GET', '/api/auth/me'); } catch { showLogin(); return; }
  }
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('topAv').textContent  = (ME.name || ME.email || '?').slice(0, 2).toUpperCase();
  document.getElementById('topName').textContent = ME.name || ME.email;
  const roleEl = document.getElementById('topRole');
  if (roleEl) roleEl.textContent = ME.role ? `[ ${ME.role} ]` : '';

  if (ME.must_change_password) {
    document.getElementById('changePwScreen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    return;
  }

  document.getElementById('app').style.display = 'flex';

  const startPage = applyRoleNav(ME.role);
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + startPage)?.classList.add('active');
  const crumb = document.getElementById('crumbTitle');
  if (crumb) crumb.textContent = PAGE_TITLES[startPage] || startPage;

  if (startPage === 'dashboard') { loadDashboard(); loadLs(); }
  else if (startPage === 'home-care') { loadHomeCare(); }
  else { loadDashboard(); loadLs(); }
}

function showLogin() {
  localStorage.removeItem('lp_tk');
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}
```

- [ ] **Step 4: Smoke test — every page reachable**

Restart server: `pm2 restart loyalpro`. Open browser to `http://localhost:3001/`, log in. Verify:
- Sidebar visible on the left with brand, nav, user-chip.
- Click each nav link — page switches; `crumbTitle` updates; `.nav-a.active` moves to the clicked link.
- Resize window <1024px — sidebar hides, burger button appears in topbar.
- Click burger → sidebar slides in + overlay appears. Click overlay → closes. Press Esc → closes.
- All 8 pages load without console errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/css/glass.css frontend/js/core/nav.js
git commit -m "feat(layout): replace topbar with sidebar+main shell, add mobile drawer"
```

---

### Task 6: Page-level palette compatibility check (smoke pass over all 8 pages)

**Files:**
- None — this is verification only. If a page is visibly broken, fix it inline (most likely candidates: Records page tables, Settings tabs).

- [ ] **Step 1: Open each page in turn via Playwright MCP**

Use the Playwright MCP tools (`mcp__playwright__browser_navigate`, `mcp__playwright__browser_take_screenshot`) to:

1. Navigate to `http://localhost:3001/`, log in (existing test credentials, or document them as a prereq).
2. Click each sidebar link in turn.
3. For each page, take a screenshot and visually verify: no horizontal scroll, no overlapping content, tables fit.

- [ ] **Step 2: Catalogue any bugs found**

If any page has visible breakage caused by the layout change, **stop and fix it before proceeding**. Likely fixes:
- A page with hard-coded `width: 100vw` → change to `100%`.
- A page with `position: fixed; top: 60px` (assuming old topbar height) → change to `top: 0` since no topbar above pages now.

Record fixes in this task's commit.

- [ ] **Step 3: Commit (only if fixes were needed)**

```bash
git add frontend/...
git commit -m "fix(layout): page X compatibility with new shell"
```

If no fixes needed, no commit — just check the box and move on.

---

## Phase 3 — Settings → Внешний вид

### Task 7: Add `🎨 Интерфейс` group + `#stg-appearance` section in markup

**Files:**
- Modify: `frontend/index.html` — settings sidebar groups + new `<div class="stg-section" id="stg-appearance">`

- [ ] **Step 1: Insert "Интерфейс" group above "🏆 Лояльность"**

In `index.html`, find the settings sidebar block (`stg-group-lbl` rows around line 362). Insert this NEW group BEFORE the existing `<div class="stg-group-lbl">🏆 Лояльность</div>`:

```html
<div class="stg-group-lbl">🎨 Интерфейс</div>
<div class="stg-item active" data-sec="appearance" onclick="navStg('appearance',this)"><span class="stg-ic">🎨</span>Внешний вид</div>
```

Then remove `class="stg-item active"` from the existing first item (loyalty-levels) — appearance is now the default.

- [ ] **Step 2: Add `#stg-appearance` section markup**

Insert this BEFORE `<div class="stg-section active" id="stg-loyalty-levels">` (note: also remove `active` class from `stg-loyalty-levels`):

```html
<div class="stg-section active" id="stg-appearance">
  <h3 class="ct" style="margin-bottom:6px">Тема оформления</h3>
  <div style="color:var(--t3); font-size:12px; margin-bottom:18px">Выберите внешний вид интерфейса</div>

  <div class="theme-grid">
    <label class="theme-card gl">
      <input type="radio" name="lp-theme" value="glass" checked>
      <div class="theme-prev theme-prev-glass">
        <span style="background:#fcfcf8"></span>
        <span style="background:#d3fa99"></span>
        <span style="background:#1b2710"></span>
      </div>
      <div class="theme-name">Glass</div>
      <div class="theme-desc">Cream + olive, glassmorphism</div>
    </label>
    <div class="theme-card theme-card-disabled">
      <div class="theme-name">Скоро</div>
      <div class="theme-desc">Новые темы появятся в следующих обновлениях</div>
    </div>
  </div>

  <div class="fg" style="margin-top:24px">
    <label style="display:flex; align-items:center; gap:10px; cursor:pointer">
      <input type="checkbox" id="reduceMotionToggle">
      <span>Уменьшить анимации</span>
    </label>
    <div style="color:var(--t3); font-size:11px; margin-top:6px; padding-left:24px">Отключает плавающие пятна на фоне</div>
  </div>
</div>
```

- [ ] **Step 3: Append `.theme-grid` / `.theme-card` styles to `glass.css`**

```css
[data-theme="glass"] .theme-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(220px,1fr)); gap: 14px;
}
[data-theme="glass"] .theme-card {
  display: block; padding: 16px; border-radius: var(--radius-md); cursor: pointer;
  border: 1px solid var(--hairline-d);
}
[data-theme="glass"] .theme-card input[type="radio"] {
  position: absolute; opacity: 0; pointer-events: none;
}
[data-theme="glass"] .theme-card:has(input:checked) {
  outline: 2px solid var(--olive-3); outline-offset: -2px;
}
[data-theme="glass"] .theme-card-disabled { opacity: .55; cursor: default; }
[data-theme="glass"] .theme-prev {
  display: flex; gap: 4px; height: 40px; margin-bottom: 10px; border-radius: 8px; overflow: hidden;
}
[data-theme="glass"] .theme-prev > span { flex: 1; }
[data-theme="glass"] .theme-name { font-weight: 500; font-size: 13px; color: var(--ink); }
[data-theme="glass"] .theme-desc { font-size: 11px; color: var(--ink-3); margin-top: 2px; }
```

- [ ] **Step 4: Smoke check**

Reload, navigate to Настройки. Sidebar of settings page now shows "🎨 Интерфейс" group at top with "Внешний вид" selected by default. Right pane shows the theme grid with Glass card (selected, outlined) + "Скоро" placeholder + reduce-motion checkbox.

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/css/glass.css
git commit -m "feat(settings): add 'Внешний вид' section with theme selector + reduce-motion"
```

---

### Task 8: Wire up appearance handlers in `settings.js`

**Files:**
- Modify: `frontend/js/pages/settings.js` — add `loadAppearance()`

- [ ] **Step 1: Add `loadAppearance` and listeners**

Append to `frontend/js/pages/settings.js`:

```js
function loadAppearance() {
  // Sync checkbox state from localStorage
  const cb = document.getElementById('reduceMotionToggle');
  if (cb) {
    cb.checked = localStorage.getItem('lp_reduce_motion') === '1';
    cb.onchange = () => setReduceMotion(cb.checked);
  }
  // Sync radio
  const radios = document.querySelectorAll('input[name="lp-theme"]');
  const current = (typeof getTheme === 'function') ? getTheme() : 'glass';
  radios.forEach(r => {
    r.checked = (r.value === current);
    r.onchange = () => { if (r.checked) setTheme(r.value); };
  });
}
```

- [ ] **Step 2: Smoke test**

Reload → Настройки → Внешний вид:
- Reduce-motion checkbox: tick → `<html>` gets `.no-motion`, aurora orbs stop. Untick → resumes. Reload page → checkbox state preserved.
- Theme radio: only Glass is selectable; clicking it is no-op (already glass).

- [ ] **Step 3: Commit**

```bash
git add frontend/js/pages/settings.js
git commit -m "feat(settings): wire appearance handlers (theme radio + reduce-motion)"
```

---

## Phase 4 — Dashboard rebuild

### Task 9: Replace `#page-dashboard` markup with new structure

**Files:**
- Modify: `frontend/index.html` — replace entire `<div class="page active" id="page-dashboard">…</div>` block

- [ ] **Step 1: Identify current dashboard markup boundaries**

In `index.html`, find `<div class="page active" id="page-dashboard">` (~line 110). Find its matching closing `</div>` (the page block ends just before the next `<div class="page" id="page-clients">`). Approximate range: 110 to ~170.

- [ ] **Step 2: Replace with new markup**

Replace the entire `#page-dashboard` block with:

```html
<div class="page active" id="page-dashboard">

  <!-- Hero -->
  <section class="hero gl">
    <div>
      <div class="hero-greet" id="heroGreet">доброе утро</div>
      <h1 class="hero-title">сегодня — <em>хороший</em> день для красоты.</h1>
      <p class="hero-sub" id="heroSub">—</p>
    </div>
    <div class="period" role="tablist" id="dashPeriod">
      <button data-d="1">день</button>
      <button data-d="7" class="on">7 дней</button>
      <button data-d="30">30 дней</button>
      <button data-d="365">год</button>
    </div>
  </section>

  <!-- Metrics -->
  <section class="metrics" id="dashMetrics">
    <article class="metric gl" data-k="revenue">
      <div class="m-head"><span class="m-label">выручка</span></div>
      <div class="m-value" id="mtRevenue">—</div>
      <div class="m-foot"><span class="delta" id="mtRevenueDelta"></span><span class="m-note" id="mtRevenueNote">vs прошлый период</span></div>
      <svg class="m-spark" viewBox="0 0 88 30" preserveAspectRatio="none"><path id="mtRevenueSpark" d="" stroke="#1b2710" stroke-width="1.3" fill="none" stroke-linejoin="round" stroke-linecap="round"/></svg>
    </article>
    <article class="metric gl" data-k="visits">
      <div class="m-head"><span class="m-label">визиты</span></div>
      <div class="m-value" id="mtVisits">—</div>
      <div class="m-foot"><span class="delta" id="mtVisitsDelta"></span><span class="m-note" id="mtVisitsNote"></span></div>
      <svg class="m-spark" viewBox="0 0 88 30" preserveAspectRatio="none"><path id="mtVisitsSpark" d="" stroke="#1b2710" stroke-width="1.3" fill="none" stroke-linejoin="round" stroke-linecap="round"/></svg>
    </article>
    <article class="metric gl" data-k="avg">
      <div class="m-head"><span class="m-label">средний чек</span></div>
      <div class="m-value" id="mtAvg">—</div>
      <div class="m-foot"><span class="delta" id="mtAvgDelta"></span><span class="m-note">за период</span></div>
      <svg class="m-spark" viewBox="0 0 88 30" preserveAspectRatio="none"><path id="mtAvgSpark" d="" stroke="#1b2710" stroke-width="1.3" fill="none" stroke-linejoin="round" stroke-linecap="round"/></svg>
    </article>
    <article class="metric gl" data-k="bonuses">
      <div class="m-head"><span class="m-label">бонусы</span></div>
      <div class="m-value" id="mtBonuses">—</div>
      <div class="m-foot"><span class="delta" id="mtBonusesDelta"></span><span class="m-note" id="mtBonusesNote"></span></div>
      <svg class="m-spark" viewBox="0 0 88 30" preserveAspectRatio="none"><path id="mtBonusesSpark" d="" stroke="#1b2710" stroke-width="1.3" fill="none" stroke-linejoin="round" stroke-linecap="round" stroke-opacity=".5"/></svg>
    </article>
  </section>

  <!-- Chart + top services -->
  <section class="grid-2">
    <article class="card gl">
      <div class="card-head">
        <div>
          <h2 class="card-title">денежный поток</h2>
          <div class="card-sub">выручка, начисления и списания</div>
        </div>
        <div class="legend">
          <span><i style="background:#1b2710"></i>выручка</span>
          <span><i style="background:#6b8c3a"></i>начислено</span>
          <span><i style="background:#b89868"></i>списано</span>
        </div>
      </div>
      <div class="chart-wrap" id="cashFlowChart"></div>
    </article>

    <article class="card gl">
      <div class="card-head">
        <div>
          <h2 class="card-title">топ услуг</h2>
          <div class="card-sub">по числу визитов</div>
        </div>
      </div>
      <div class="svc" id="topServicesList"></div>
    </article>
  </section>

  <!-- Bottom row: segments + upcoming -->
  <section class="grid-2">
    <article class="card gl">
      <div class="card-head"><div><h2 class="card-title">сегменты клиентов</h2><div class="card-sub" id="segCardSub">—</div></div></div>
      <div class="seg" id="segmentsWidget"></div>
    </article>
    <article class="card gl">
      <div class="card-head"><div><h2 class="card-title">сегодня в зале</h2><div class="card-sub">ближайшие записи</div></div></div>
      <div id="upcomingList"></div>
    </article>
  </section>

  <!-- Activity feed full width -->
  <article class="card gl">
    <div class="card-head"><div><h2 class="card-title">лента бонусов</h2><div class="card-sub">последние операции</div></div></div>
    <div class="feed" id="feedList"></div>
  </article>

</div>
```

- [ ] **Step 3: Append dashboard widget styles to `glass.css`**

```css
/* ── Dashboard widgets ───────────────────────────────────── */
[data-theme="glass"] .hero {
  display: flex; justify-content: space-between; align-items: end; gap: 24px;
  padding: 26px 28px; margin-bottom: 22px;
}
[data-theme="glass"] .hero-greet { font-size: 12px; color: var(--ink-3); text-transform: lowercase; letter-spacing: .04em; }
[data-theme="glass"] .hero-title { font-size: 32px; font-weight: 400; line-height: 1.2; color: var(--ink); margin: 6px 0 10px; letter-spacing: -.02em; }
[data-theme="glass"] .hero-title em { font-style: italic; color: var(--olive-3); }
[data-theme="glass"] .hero-sub { font-size: 13px; color: var(--ink-2); max-width: 600px; line-height: 1.45; }
[data-theme="glass"] .period {
  display: flex; gap: 2px; padding: 3px;
  background: rgba(27,39,16,.05); border-radius: 12px;
}
[data-theme="glass"] .period button {
  border: none; background: transparent; cursor: pointer;
  padding: 7px 13px; font-size: 12px; color: var(--ink-3);
  border-radius: 9px; font-family: inherit;
}
[data-theme="glass"] .period button.on { background: var(--cream); color: var(--ink); box-shadow: 0 1px 3px rgba(27,39,16,.08); }

[data-theme="glass"] .metrics {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 18px;
}
[data-theme="glass"] .metric { padding: 18px; }
[data-theme="glass"] .m-head { display: flex; justify-content: space-between; margin-bottom: 14px; }
[data-theme="glass"] .m-label { font-size: 11px; color: var(--ink-3); text-transform: lowercase; letter-spacing: .04em; }
[data-theme="glass"] .m-value { font-size: 28px; font-weight: 450; color: var(--ink); letter-spacing: -.02em; }
[data-theme="glass"] .m-value sup { font-size: 13px; font-weight: 400; color: var(--ink-3); margin-left: 2px; }
[data-theme="glass"] .m-foot { display: flex; gap: 8px; align-items: baseline; margin-top: 6px; font-size: 11px; }
[data-theme="glass"] .delta.up { color: var(--olive-3); }
[data-theme="glass"] .delta.dn { color: var(--champagne); }
[data-theme="glass"] .m-note { color: var(--ink-3); }
[data-theme="glass"] .m-spark { width: 100%; height: 30px; margin-top: 10px; }

[data-theme="glass"] .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
@media (max-width: 1100px) { [data-theme="glass"] .metrics { grid-template-columns: repeat(2,1fr); } [data-theme="glass"] .grid-2 { grid-template-columns: 1fr; } }

[data-theme="glass"] .card { padding: 22px; }
[data-theme="glass"] .card-head { display: flex; justify-content: space-between; margin-bottom: 16px; }
[data-theme="glass"] .card-title { font-size: 14px; font-weight: 500; color: var(--ink); }
[data-theme="glass"] .card-sub { font-size: 11px; color: var(--ink-3); margin-top: 2px; }
[data-theme="glass"] .legend { display: flex; gap: 12px; font-size: 10px; color: var(--ink-3); align-items: center; }
[data-theme="glass"] .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
[data-theme="glass"] .chart-wrap { width: 100%; height: 240px; }
[data-theme="glass"] .chart-wrap svg { width: 100%; height: 100%; }
[data-theme="glass"] .grid-line { stroke: rgba(27,39,16,.06); stroke-width: 1; }
[data-theme="glass"] .axis-text { font-size: 9px; fill: var(--ink-3); font-family: ui-monospace, monospace; }

[data-theme="glass"] .svc-row { display: grid; grid-template-columns: 1fr auto auto; gap: 14px; align-items: end; padding: 10px 0; border-bottom: 1px solid var(--hairline-d); }
[data-theme="glass"] .svc-row:last-child { border-bottom: none; }
[data-theme="glass"] .svc-name { font-size: 13px; color: var(--ink); }
[data-theme="glass"] .svc-meta { font-size: 10px; color: var(--ink-3); margin-top: 2px; }
[data-theme="glass"] .svc-bar { height: 3px; background: rgba(27,39,16,.06); border-radius: 2px; margin-top: 8px; overflow: hidden; }
[data-theme="glass"] .svc-bar i { display: block; height: 100%; background: linear-gradient(90deg, #6b8c3a, #b8e070); border-radius: inherit; }
[data-theme="glass"] .svc-num { font-size: 13px; color: var(--ink); }
[data-theme="glass"] .svc-cnt { font-size: 11px; color: var(--ink-3); }

[data-theme="glass"] .seg { display: grid; grid-template-columns: 130px 1fr; gap: 18px; align-items: center; }
[data-theme="glass"] .donut { position: relative; width: 130px; height: 130px; }
[data-theme="glass"] .donut svg { width: 100%; height: 100%; transform: rotate(-90deg); }
[data-theme="glass"] .donut-center { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; }
[data-theme="glass"] .donut-center b { font-size: 18px; font-weight: 500; color: var(--ink); }
[data-theme="glass"] .donut-center span { font-size: 10px; color: var(--ink-3); }
[data-theme="glass"] .seg-list { display: flex; flex-direction: column; gap: 6px; }
[data-theme="glass"] .seg-row { display: grid; grid-template-columns: 14px 1fr auto; gap: 8px; align-items: center; font-size: 12px; }
[data-theme="glass"] .seg-dot { width: 8px; height: 8px; border-radius: 50%; }
[data-theme="glass"] .seg-name { color: var(--ink-2); }
[data-theme="glass"] .seg-val { color: var(--ink); font-weight: 500; }

[data-theme="glass"] .upcoming-row { display: grid; grid-template-columns: 70px 1fr auto; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--hairline-d); align-items: center; }
[data-theme="glass"] .upcoming-row:last-child { border-bottom: none; }
[data-theme="glass"] .time-tag { font-size: 11px; color: var(--ink-3); font-family: ui-monospace, monospace; }
[data-theme="glass"] .time-tag.now { color: var(--olive-3); font-weight: 500; }
[data-theme="glass"] .upcoming-name { font-size: 13px; color: var(--ink); }
[data-theme="glass"] .upcoming-svc { font-size: 11px; color: var(--ink-3); margin-top: 2px; }
[data-theme="glass"] .upcoming-spec { font-size: 11px; color: var(--ink-3); }

[data-theme="glass"] .feed { display: flex; flex-direction: column; gap: 10px; }
[data-theme="glass"] .fi { display: grid; grid-template-columns: 32px 1fr auto; gap: 12px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--hairline-d); }
[data-theme="glass"] .fi:last-child { border-bottom: none; }
[data-theme="glass"] .fi-ic { width: 32px; height: 32px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 14px; }
[data-theme="glass"] .fi-ic.up { background: rgba(107,140,58,.12); color: var(--olive-3); }
[data-theme="glass"] .fi-ic.dn { background: rgba(184,152,104,.18); color: var(--champagne); }
[data-theme="glass"] .fi-ic.warm { background: rgba(184,152,104,.18); color: var(--champagne); }
[data-theme="glass"] .fi-text { font-size: 12px; color: var(--ink); }
[data-theme="glass"] .fi-meta { font-size: 10px; color: var(--ink-3); margin-top: 2px; }
[data-theme="glass"] .fi-amt { font-size: 13px; font-weight: 500; }
[data-theme="glass"] .fi-amt.up { color: var(--olive-3); }
[data-theme="glass"] .fi-amt.dn { color: var(--champagne); }
```

- [ ] **Step 4: Smoke check**

Reload Дашборд. Markup is empty/dashed (data not yet wired) but layout renders without console errors. Hero, 4 metric placeholders, 2 cards row, segments+upcoming row, feed — all visible.

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/css/glass.css
git commit -m "feat(dashboard): new markup + styles for hero/metrics/chart/segments/feed"
```

---

### Task 10: Pure formatter functions + tests (hero subtitle, feed type, sparkline path)

**Files:**
- Create: `frontend/js/pages/dashboard-formatters.js`
- Create: `frontend/tests/dashboard-formatters.test.js`
- Modify: `frontend/index.html` — `<script src="js/pages/dashboard-formatters.js"></script>` BEFORE `dashboard.js`

- [ ] **Step 1: Write failing tests**

Create `frontend/tests/dashboard-formatters.test.js`:

```js
const assert = require('assert');
const path = require('path');

// Load formatters by reading the file and eval-ing into a sandbox.
const fs = require('fs');
const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'pages', 'dashboard-formatters.js'), 'utf8');
const sandbox = {};
new Function('exports', code + '\nexports.classifyFeedItem = classifyFeedItem; exports.greetByHour = greetByHour; exports.sparklinePath = sparklinePath; exports.heroSubtitle = heroSubtitle;')(sandbox);
const { classifyFeedItem, greetByHour, sparklinePath, heroSubtitle } = sandbox;

// classifyFeedItem
assert.deepStrictEqual(classifyFeedItem({ amount: 100, description: 'начисление за визит' }).type, 'accrual');
assert.deepStrictEqual(classifyFeedItem({ amount: -480, description: 'списание' }).type, 'redemption');
assert.deepStrictEqual(classifyFeedItem({ amount: 500, description: 'поздравление с Днём рождения' }).type, 'birthday');
assert.deepStrictEqual(classifyFeedItem({ amount: 300, description: 'реферальный бонус' }).type, 'referral');
assert.strictEqual(classifyFeedItem({ amount: 100, description: 'начисление' }).cls, 'up');
assert.strictEqual(classifyFeedItem({ amount: -100, description: 'списание' }).cls, 'dn');
assert.strictEqual(classifyFeedItem({ amount: 500, description: 'день рождения' }).cls, 'warm');

// greetByHour
assert.strictEqual(greetByHour(7),  'доброе утро');
assert.strictEqual(greetByHour(13), 'добрый день');
assert.strictEqual(greetByHour(19), 'добрый вечер');
assert.strictEqual(greetByHour(2),  'доброй ночи');

// sparklinePath
const path1 = sparklinePath([0, 5, 3, 8, 6, 10, 7], 88, 30);
assert.match(path1, /^M0 \d+(\.\d+)?( L\d+(\.\d+)? \d+(\.\d+)?)+$/, 'sparklinePath shape');
assert.strictEqual(sparklinePath([], 88, 30), '', 'empty array → empty path');
assert.strictEqual(sparklinePath([5], 88, 30), '', 'single point → empty path (no line)');

// heroSubtitle
const sub = heroSubtitle({ visits: 12, newCardClients: 4, revenueDeltaPct: 18 });
assert.match(sub, /12 записей/);
assert.match(sub, /4 нов/);
assert.match(sub, /18\s*%/);
const subFlat = heroSubtitle({ visits: 7, newCardClients: 0, revenueDeltaPct: 0 });
assert.match(subFlat, /7 записей/);

console.log('dashboard-formatters.test: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node tests/dashboard-formatters.test.js`
Expected: FAIL — "Cannot find module … dashboard-formatters.js" or similar.

- [ ] **Step 3: Implement formatters**

Create `frontend/js/pages/dashboard-formatters.js`:

```js
// Pure helpers used by dashboard.js — no DOM access, easy to test.

function classifyFeedItem(txn) {
  const desc = (txn.description || '').toLowerCase();
  if (desc.includes('день рождения') || desc.includes('др ') || desc.includes('подарок')) {
    return { type: 'birthday', cls: 'warm' };
  }
  if (desc.includes('реферал') || desc.includes('пригласи') || desc.includes('подруг')) {
    return { type: 'referral', cls: 'up' };
  }
  if ((txn.amount || 0) < 0) return { type: 'redemption', cls: 'dn' };
  return { type: 'accrual', cls: 'up' };
}

function greetByHour(h) {
  if (h >= 5  && h < 12) return 'доброе утро';
  if (h >= 12 && h < 18) return 'добрый день';
  if (h >= 18 && h < 23) return 'добрый вечер';
  return 'доброй ночи';
}

function sparklinePath(values, width, height) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values);
  const range = (max - min) || 1;
  const stepX = width / (values.length - 1);
  return values.map((v, i) => {
    const x = +(i * stepX).toFixed(2);
    const y = +(height - ((v - min) / range) * height).toFixed(2);
    return (i === 0 ? `M${x} ${y}` : `L${x} ${y}`);
  }).join(' ');
}

function heroSubtitle({ visits, newCardClients, revenueDeltaPct }) {
  const parts = [];
  parts.push(`${visits} записей`);
  if (newCardClients > 0) parts.push(`${newCardClients} новых клиентов подключили карту`);
  if (revenueDeltaPct && Math.abs(revenueDeltaPct) >= 1) {
    const dir = revenueDeltaPct > 0 ? 'опережает' : 'отстаёт от';
    parts.push(`выручка ${dir} прошлый период на ${Math.abs(Math.round(revenueDeltaPct))} %`);
  }
  return parts.join(', ') + '.';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && node tests/dashboard-formatters.test.js`
Expected: `dashboard-formatters.test: all assertions passed`

- [ ] **Step 5: Wire `dashboard-formatters.js` into `index.html`**

Find `<script src="js/pages/dashboard.js"></script>` in `index.html`. Add immediately BEFORE it:
```html
<script src="js/pages/dashboard-formatters.js"></script>
```

- [ ] **Step 6: Commit**

```bash
git add frontend/js/pages/dashboard-formatters.js frontend/tests/dashboard-formatters.test.js frontend/index.html
git commit -m "feat(dashboard): pure formatters (feed type, greeting, sparkline, hero subtitle) + tests"
```

---

### Task 11: Rewrite `dashboard.js` to render new widgets

**Files:**
- Modify: `frontend/js/pages/dashboard.js` — full rewrite

- [ ] **Step 1: Replace `dashboard.js` body**

Overwrite `frontend/js/pages/dashboard.js` with:

```js
// Зависимости: api(), animateCount(), classifyFeedItem(), greetByHour(), sparklinePath(), heroSubtitle()

let _dashPeriod = 7;
let _dashCache = null;

async function loadDashboard() {
  setHero(null);
  try {
    // Fetch in parallel: dashboard analytics, segments, today's records.
    const today = new Date();
    const ymd = today.toISOString().slice(0, 10);
    const [dash, segs, todayRecs] = await Promise.all([
      api('GET', `/api/analytics/dashboard?period=${_dashPeriod}`),
      api('GET', '/api/segments').catch(() => null),
      api('GET', `/api/records?dateFrom=${ymd}&dateTo=${ymd}&limit=10`).catch(() => null),
    ]);
    _dashCache = { dash, segs, todayRecs };
    renderDashHero(dash);
    renderDashMetrics(dash);
    renderCashFlowChart(dash);
    renderTopServices(dash);
    renderSegments(segs);
    renderUpcoming(todayRecs);
    renderFeed(dash);
  } catch (e) {
    notify('Не удалось загрузить дашборд: ' + (e.message || e), 'error');
    console.error(e);
  }
}

function setHero(dash) {
  const greet = document.getElementById('heroGreet');
  const sub = document.getElementById('heroSub');
  if (greet) {
    const name = (typeof ME !== 'undefined' && ME && ME.name) ? `, ${ME.name.split(' ')[0]}` : '';
    greet.textContent = greetByHour(new Date().getHours()) + name;
  }
  if (sub) sub.textContent = dash ? heroSubtitle({
    visits: dash.stats.periodRecords || 0,
    newCardClients: dash.stats.newClients || 0,
    revenueDeltaPct: 0, // computed below in renderDashHero with sparkline data
  }) : '—';
}

function renderDashHero(dash) {
  // recompute revenueDelta from dailyRevenue (first half vs second half of period)
  const daily = dash.dailyRevenue || [];
  let pct = 0;
  if (daily.length >= 4) {
    const half = Math.floor(daily.length / 2);
    const a = daily.slice(0, half).reduce((s, r) => s + parseFloat(r.revenue || 0), 0);
    const b = daily.slice(-half).reduce((s, r) => s + parseFloat(r.revenue || 0), 0);
    if (a > 0) pct = ((b - a) / a) * 100;
  }
  const sub = document.getElementById('heroSub');
  if (sub) sub.textContent = heroSubtitle({
    visits: dash.stats.periodRecords || 0,
    newCardClients: dash.stats.newClients || 0,
    revenueDeltaPct: pct,
  });
}

function renderDashMetrics(dash) {
  const s = dash.stats;
  const daily = dash.dailyRevenue || [];

  // Revenue
  setText('mtRevenue', fmtMoney(s.periodRevenue));
  setSpark('mtRevenueSpark', daily.map(r => parseFloat(r.revenue || 0)));
  setDelta('mtRevenueDelta', computeHalfDelta(daily, 'revenue'));

  // Visits
  setText('mtVisits', String(s.periodRecords || 0));
  setSpark('mtVisitsSpark', daily.map(r => parseInt(r.records || 0)));
  setDelta('mtVisitsDelta', computeHalfDelta(daily, 'records'));

  // Avg check
  const avg = (s.periodRecords > 0) ? Math.round(s.periodRevenue / s.periodRecords) : 0;
  setText('mtAvg', fmtMoney(avg));
  // sparkline of revenue/records per day
  setSpark('mtAvgSpark', daily.map(r => {
    const rev = parseFloat(r.revenue || 0), rec = parseInt(r.records || 0);
    return rec > 0 ? rev / rec : 0;
  }));

  // Bonuses (accrued; note: redeemed)
  setText('mtBonuses', String(Math.round(s.periodBonuses || 0)));
  setSpark('mtBonusesSpark', daily.map(r => parseFloat(r.bonuses_accrued || 0)));
  document.getElementById('mtBonusesNote').textContent = `списано ${Math.round(s.periodRedeemed || 0)} ₽`;
  setDelta('mtBonusesDelta', computeHalfDelta(daily, 'bonuses_accrued'));
}

function computeHalfDelta(daily, key) {
  if (!daily || daily.length < 4) return 0;
  const half = Math.floor(daily.length / 2);
  const a = daily.slice(0, half).reduce((s, r) => s + parseFloat(r[key] || 0), 0);
  const b = daily.slice(-half).reduce((s, r) => s + parseFloat(r[key] || 0), 0);
  if (a === 0) return b > 0 ? 100 : 0;
  return ((b - a) / a) * 100;
}

function renderCashFlowChart(dash) {
  const wrap = document.getElementById('cashFlowChart');
  if (!wrap) return;
  const daily = dash.dailyRevenue || [];
  if (!daily.length) { wrap.innerHTML = '<div style="padding:40px;color:var(--ink-3);text-align:center">нет данных за период</div>'; return; }

  const W = 600, H = 240, P = 30;
  const xs = daily.map((_, i) => P + (W - 2 * P) * (daily.length === 1 ? 0 : i / (daily.length - 1)));
  const maxV = Math.max(1, ...daily.map(r => Math.max(parseFloat(r.revenue || 0), parseFloat(r.bonuses_accrued || 0), parseFloat(r.bonuses_redeemed || 0))));
  const yOf = v => P + (H - 2 * P) * (1 - v / maxV);

  const lineRev = daily.map((r, i) => `${i === 0 ? 'M' : 'L'}${xs[i]} ${yOf(parseFloat(r.revenue || 0))}`).join(' ');
  const fillRev = lineRev + ` L${xs[xs.length - 1]} ${H - P} L${xs[0]} ${H - P} Z`;
  const lineAcc = daily.map((r, i) => `${i === 0 ? 'M' : 'L'}${xs[i]} ${yOf(parseFloat(r.bonuses_accrued || 0))}`).join(' ');
  const lineRed = daily.map((r, i) => `${i === 0 ? 'M' : 'L'}${xs[i]} ${yOf(parseFloat(r.bonuses_redeemed || 0))}`).join(' ');

  const grid = [P, P + (H - 2 * P) / 3, P + 2 * (H - 2 * P) / 3, H - P]
    .map(y => `<line class="grid-line" x1="0" y1="${y}" x2="${W}" y2="${y}"/>`).join('');
  const labels = daily.length <= 14
    ? daily.map((r, i) => `<text class="axis-text" x="${xs[i] - 8}" y="${H - 8}">${(r.visit_date || '').slice(8)}</text>`).join('')
    : '';

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="rev-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#1b2710" stop-opacity=".12"/>
          <stop offset="1" stop-color="#1b2710" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}
      <path d="${fillRev}" fill="url(#rev-grad)"/>
      <path d="${lineRev}" stroke="#1b2710" stroke-width="1.6" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${lineAcc}" stroke="#6b8c3a" stroke-width="1.4" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${lineRed}" stroke="#b89868" stroke-width="1.4" fill="none" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="2 4"/>
      ${labels}
    </svg>`;
}

function renderTopServices(dash) {
  const list = document.getElementById('topServicesList');
  if (!list) return;
  const top = (dash.topServices || [])
    .map(s => ({ name: s.service_name, cnt: parseInt(s.cnt), total: parseFloat(s.total_amount || 0) }))
    .sort((a, b) => b.cnt - a.cnt)
    .slice(0, 5);
  if (!top.length) { list.innerHTML = '<div style="padding:14px;color:var(--ink-3)">нет данных</div>'; return; }
  const maxCnt = top[0].cnt;
  list.innerHTML = top.map(s => `
    <div class="svc-row">
      <div>
        <div class="svc-name">${escapeHtml(s.name)}</div>
        <div class="svc-meta">${s.cnt > 0 ? Math.round(s.total / s.cnt) + ' ₽ ср.' : ''}</div>
        <div class="svc-bar"><i style="width:${Math.round(s.cnt / maxCnt * 100)}%"></i></div>
      </div>
      <div class="svc-num">${fmtMoney(s.total)}</div>
      <div class="svc-cnt">${s.cnt}×</div>
    </div>
  `).join('');
}

function renderSegments(segs) {
  const widget = document.getElementById('segmentsWidget');
  const sub = document.getElementById('segCardSub');
  if (!widget) return;
  if (!segs || !segs.segments) { widget.innerHTML = '<div style="color:var(--ink-3)">сегменты недоступны</div>'; return; }

  const colors = ['#1b2710', '#6b8c3a', '#cdd9c4', '#b89868', 'rgba(27,39,16,.18)'];
  const total = (segs.segments || []).reduce((s, x) => s + (parseInt(x.client_count) || 0), 0);
  if (sub) sub.textContent = `активная база · ${total} клиентов`;

  const top5 = (segs.segments || []).slice(0, 5);
  const C = 50, R = 38, CIRC = 2 * Math.PI * R;
  let off = 0;
  const slices = top5.map((s, i) => {
    const cnt = parseInt(s.client_count) || 0;
    const len = total > 0 ? (cnt / total) * CIRC : 0;
    const seg = `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${colors[i] || colors[4]}" stroke-width="10" stroke-dasharray="${len.toFixed(2)} ${(CIRC - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" stroke-linecap="butt"/>`;
    off += len;
    return seg;
  }).join('');

  widget.innerHTML = `
    <div class="donut">
      <svg viewBox="0 0 100 100">
        <circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="rgba(27,39,16,.06)" stroke-width="10"/>
        ${slices}
      </svg>
      <div class="donut-center"><div><b>${total}</b><span>всего</span></div></div>
    </div>
    <div class="seg-list">
      ${top5.map((s, i) => `
        <div class="seg-row">
          <span class="seg-dot" style="background:${colors[i] || colors[4]}"></span>
          <span class="seg-name">${escapeHtml(s.label || s.segment_key)}</span>
          <span class="seg-val">${s.client_count || 0}</span>
        </div>
      `).join('')}
    </div>`;
}

function renderUpcoming(todayRecs) {
  const list = document.getElementById('upcomingList');
  if (!list) return;
  if (!todayRecs || !todayRecs.records || !todayRecs.records.length) {
    list.innerHTML = '<div style="padding:14px;color:var(--ink-3)">сегодня записей нет</div>';
    return;
  }
  const now = new Date();
  // Sort ascending by visit_datetime (or visit_date), filter only future-or-current
  const records = (todayRecs.records || [])
    .map(r => ({
      ...r,
      _t: new Date(r.visit_datetime || r.visit_date || 0),
    }))
    .sort((a, b) => a._t - b._t)
    .slice(0, 5);

  list.innerHTML = records.map(r => {
    const isNow = Math.abs(r._t - now) < 30 * 60 * 1000;
    const hh = String(r._t.getHours()).padStart(2, '0');
    const mm = String(r._t.getMinutes()).padStart(2, '0');
    const tag = isNow ? '<div class="time-tag now">сейчас</div>' : `<div class="time-tag">${hh}:${mm}</div>`;
    const services = Array.isArray(r.services) ? r.services.map(s => s.title || s.name).filter(Boolean).join(', ') : (r.services_label || '');
    return `
      <div class="upcoming-row">
        ${tag}
        <div>
          <div class="upcoming-name">${escapeHtml(r.client_name || 'Клиент')}</div>
          <div class="upcoming-svc">${escapeHtml(services || '—')}</div>
        </div>
        <div class="upcoming-spec">${escapeHtml(r.staff_name || '—')}</div>
      </div>`;
  }).join('');
}

function renderFeed(dash) {
  const list = document.getElementById('feedList');
  if (!list) return;
  const rows = (dash.recentTxns || []).slice(0, 6);
  if (!rows.length) { list.innerHTML = '<div style="padding:14px;color:var(--ink-3)">нет операций</div>'; return; }

  list.innerHTML = rows.map(t => {
    const { type, cls } = classifyFeedItem({ amount: parseFloat(t.amount), description: t.description });
    const arrow = cls === 'up' ? '↗' : cls === 'dn' ? '↙' : '◆';
    const amt = parseFloat(t.amount);
    const sign = amt > 0 ? '+' : '−';
    const ago = t.created_at ? timeSince(new Date(t.created_at)) : '';
    return `
      <div class="fi">
        <div class="fi-ic ${cls}">${arrow}</div>
        <div>
          <div class="fi-text"><strong>${escapeHtml(t.client_name || '?')}</strong> — ${escapeHtml(t.description || type)}</div>
          <div class="fi-meta">${ago}</div>
        </div>
        <div class="fi-amt ${cls}">${sign}${Math.round(Math.abs(amt))}</div>
      </div>`;
  }).join('');
}

// ── helpers ──
function setText(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }
function setSpark(id, vals) { const el = document.getElementById(id); if (el) el.setAttribute('d', sparklinePath(vals, 88, 30)); }
function setDelta(id, pct) {
  const el = document.getElementById(id); if (!el) return;
  if (Math.abs(pct) < 0.5) { el.textContent = ''; el.className = 'delta'; return; }
  const up = pct > 0;
  el.textContent = (up ? '▲' : '▼') + ' ' + Math.abs(Math.round(pct * 10) / 10) + ' %';
  el.className = 'delta ' + (up ? 'up' : 'dn');
}
function fmtMoney(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  if (n >= 1000) return Math.round(n).toLocaleString('ru-RU') + ' ₽';
  return Math.round(n) + ' ₽';
}
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

// Period switcher binding
document.addEventListener('click', (e) => {
  const btn = e.target.closest('#dashPeriod button');
  if (!btn) return;
  document.querySelectorAll('#dashPeriod button').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  _dashPeriod = parseInt(btn.dataset.d) || 7;
  loadDashboard();
});
```

- [ ] **Step 2: Smoke test**

Reload Дашборд. Verify in browser:
1. Hero greeting matches time of day, shows your name.
2. Hero subtitle has visits + new clients + revenue delta.
3. 4 metric tiles show real numbers (not "—") with sparklines.
4. Cash-flow chart has three lines.
5. Топ услуг lists 5 services with bars.
6. Segments donut renders + list shows segment counts.
7. Сегодня в зале shows today's bookings (or "сегодня записей нет").
8. Лента бонусов shows 4-6 recent transactions.
9. Click "день" → `_dashPeriod=1`, all widgets refetch and re-render.
10. No console errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/js/pages/dashboard.js
git commit -m "feat(dashboard): rewrite render functions for 7 new widgets, real data wiring"
```

---

## Phase 5 — Cross-page smoke + polish

### Task 12: Cross-page Playwright smoke run

**Files:**
- None (verification only). If breakage found → fix before commit.

- [ ] **Step 1: Use Playwright MCP to walk every page**

Use these Playwright tools sequentially (one tool call per step):

1. `mcp__playwright__browser_navigate` to `http://localhost:3001/`.
2. (Login if needed — fill test credentials.)
3. For each page in `[dashboard, clients, records, segments, staff-analytics, home-care, settings, users]`:
   - Click sidebar link via `mcp__playwright__browser_click`.
   - `mcp__playwright__browser_snapshot` to get DOM.
   - `mcp__playwright__browser_take_screenshot` to record.
   - Verify visually: no horizontal scroll, no overlap, all interactive controls visible.
4. Verify drawer behaviour by `mcp__playwright__browser_resize` to 800×800, then check burger appears, click it, verify sidebar slides in.

- [ ] **Step 2: Document findings**

If any page broken, fix inline (likely candidates: hardcoded widths, position-fixed offsets that assumed old topbar). Each fix → commit separately.

- [ ] **Step 3: Commit (only if fixes needed)**

```bash
git commit -m "fix(layout): <page-name> compatibility with new shell"
```

---

### Task 13: Reduce-motion + backdrop-filter @supports verification

**Files:**
- None (verification + browser DevTools toggling).

- [ ] **Step 1: Verify `prefers-reduced-motion`**

Open Chrome DevTools → Rendering → Emulate CSS media feature `prefers-reduced-motion: reduce`. Verify aurora orbs become static.

- [ ] **Step 2: Verify the `.no-motion` class**

Reload, untick the Reduce-motion checkbox, verify orbs animate. Tick checkbox → orbs freeze. Reload → state preserved.

- [ ] **Step 3: Verify backdrop-filter fallback**

In DevTools Console: `CSS.supports('backdrop-filter','blur(20px)')`. If `true`, the fallback is not exercised — visually verify cards have the blurred translucent background. If running on a browser without `backdrop-filter` support, verify cards fall back to the solid `rgba(252,252,248,.92)` defined in `glass.css`.

No commit.

---

### Task 14: Update CLAUDE.md with theme + layout note

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a short section after "Frontend (staff SPA)"**

Append (or insert after the existing Frontend section in `CLAUDE.md`):

```markdown
### Theme system

Single `glass` theme (cream/olive, glassmorphism). Layout is sidebar (`<aside class="side">`) + main (`<main class="main">`), with off-canvas drawer on <1024px. Theme is set on `<html data-theme="glass">` by `js/core/theme.js`. CSS structured in two files: `css/base.css` carries shared tokens (palette swapped to cream/olive, names preserved); `css/glass.css` carries everything under `[data-theme="glass"]` selectors (aurora-orbs, sidebar, `.gl` glass-card mixin, dashboard widgets). The legacy `lp_dark` localStorage key is one-time-migrated to `lp_theme=glass` on first load. Dark mode is no longer supported.

Selector for theme switching lives in **Settings → 🎨 Интерфейс → Внешний вид**. Today only `glass` is offered; the UI is wired through `setTheme(name)` and is ready for additional themes.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): document glass theme system + sidebar layout"
```

---

## Self-review

This section is for the engineer (or you) to double-check:

1. **Spec coverage** — every section of the spec has a corresponding task:
   - Theme infrastructure → Tasks 1-3
   - Layout shell → Tasks 4-5
   - Dashboard rebuild → Tasks 9-11
   - Settings → Внешний вид → Tasks 7-8
   - Migration → Task 1 (theme.js handles lp_dark→glass)
   - Performance/edge cases → Task 13
   - Smoke test other pages → Tasks 6, 12
   - Backend endpoints → **Spec deviation**: not needed; existing `/api/analytics/dashboard` + `/api/segments` + `/api/records` already cover all data. Documented at top of plan.

2. **No placeholders** — every task contains exact files, exact code, exact commands. No TBDs.

3. **Definition of Done check (from spec):**
   - DoD #1 (Dashboard renders in glass with 6 widgets, real data) → Task 11.
   - DoD #2 (all 9 — actually 8 — pages work) → Task 12.
   - DoD #3 (drawer on <1024px) → Tasks 5, 12.
   - DoD #4 (Settings → Внешний вид exists) → Tasks 7-8.
   - DoD #5 (`🌙` button removed) → Task 5 (deleted as part of header removal).
   - DoD #6 (existing `lp_dark='1'` users migrate cleanly) → Task 1 (covered by tests).
   - DoD #7 (backend endpoints exist) → already satisfied today; documented as spec deviation.
   - DoD #8 (aurora respects prefers-reduced-motion + .no-motion) → Tasks 3, 13.
   - DoD #9 (Chrome + Safari smoke) → Task 12.
