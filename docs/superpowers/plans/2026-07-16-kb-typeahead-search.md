# База знаний — живой typeahead-поиск: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переделать поиск Базы знаний в быстрый выпадающий typeahead с префиксным полнотекстовым поиском (русская морфология сохраняется).

**Architecture:** Бэкенд `GET /api/kb/articles` получает чистую функцию `buildPrefixTsQuery(q)` и переходит с `plainto_tsquery` на `to_tsquery('russian', 'слово:*')` (префикс) + `limit`-параметр. Фронтенд добавляет позиционированный popup под строкой поиска (`kbTypeahead()`, debounce, клавиатурная навигация), не трогая просмотр папок/статей.

**Tech Stack:** Node.js/Express, PostgreSQL FTS (GIN, `russian` regconfig), Jest, vanilla JS SPA.

**Спека:** `docs/superpowers/specs/2026-07-16-kb-typeahead-search-design.md`
**Ветка:** `feature/knowledge-base`

---

### Task 1: Чистая функция `buildPrefixTsQuery` + юнит-тесты (TDD)

**Files:**
- Modify: `backend/services/knowledge-base.js`
- Test (create): `backend/knowledge-base.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/knowledge-base.test.js`:

```js
'use strict';

const { buildPrefixTsQuery } = require('./services/knowledge-base');

describe('buildPrefixTsQuery', () => {
  test('одно слово → префикс', () => {
    expect(buildPrefixTsQuery('мани')).toBe('мани:*');
  });

  test('несколько слов → & между префиксами', () => {
    expect(buildPrefixTsQuery('мани стриж')).toBe('мани:* & стриж:*');
  });

  test('схлопывает лишние пробелы', () => {
    expect(buildPrefixTsQuery('  запись   клиента ')).toBe('запись:* & клиента:*');
  });

  test('вычищает спецсимволы tsquery внутри токена', () => {
    expect(buildPrefixTsQuery('a:b|c')).toBe('abc:*');
  });

  test('токены только из спецсимволов отбрасываются', () => {
    expect(buildPrefixTsQuery('!() & |')).toBe('');
  });

  test('пустой ввод → пустая строка', () => {
    expect(buildPrefixTsQuery('   ')).toBe('');
    expect(buildPrefixTsQuery('')).toBe('');
  });

  test('не-строка → пустая строка', () => {
    expect(buildPrefixTsQuery(null)).toBe('');
    expect(buildPrefixTsQuery(undefined)).toBe('');
    expect(buildPrefixTsQuery(123)).toBe('');
  });

  test('латиница поддерживается', () => {
    expect(buildPrefixTsQuery('hello world')).toBe('hello:* & world:*');
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd backend && npx jest knowledge-base`
Expected: FAIL — `buildPrefixTsQuery is not a function`.

- [ ] **Step 3: Реализовать функцию**

В `backend/services/knowledge-base.js` добавить перед `module.exports` функцию:

```js
// Строит prefix-tsquery для to_tsquery('russian', …) из пользовательского ввода:
// разбивает по пробелам, вычищает операторы tsquery (& | ! ( ) < > : * ' " \),
// к каждому токену добавляет :* (префиксный матч), склеивает через ' & '.
// Пустой/мусорный ввод → '' (вызывающий код тогда падает в ILIKE-ветку).
function buildPrefixTsQuery(q) {
  if (typeof q !== 'string') return '';
  const tokens = q
    .split(/\s+/)
    .map(t => t.replace(/[&|!()<>:*'"\\]/g, '').trim())
    .filter(Boolean);
  if (!tokens.length) return '';
  return tokens.map(t => `${t}:*`).join(' & ');
}
```

И обновить экспорт (последняя строка файла):

```js
module.exports = { STARTER_CATEGORIES, validateArticleInput, normalizeTags, buildPrefixTsQuery };
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `cd backend && npx jest knowledge-base`
Expected: PASS (8 тестов).

- [ ] **Step 5: Коммит**

```bash
git add backend/services/knowledge-base.js backend/knowledge-base.test.js
git commit -m "feat(kb): buildPrefixTsQuery — префиксный tsquery для typeahead

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Бэкенд — `to_tsquery` префикс + `limit` в `GET /api/kb/articles`

**Files:**
- Modify: `backend/routes/knowledge-base.js:7-9` (импорт), `:127-170` (обработчик поиска)

- [ ] **Step 1: Добавить импорт `buildPrefixTsQuery`**

В `backend/routes/knowledge-base.js` заменить блок импорта (строки 7-9):

```js
const {
  STARTER_CATEGORIES, validateArticleInput, normalizeTags,
} = require('../services/knowledge-base');
```

на:

```js
const {
  STARTER_CATEGORIES, validateArticleInput, normalizeTags, buildPrefixTsQuery,
} = require('../services/knowledge-base');
```

- [ ] **Step 2: Переписать тело `GET /articles`**

Заменить весь обработчик (строки 127-170, от `router.get('/articles'` до его закрывающего `});`) на:

```js
// GET /api/kb/articles?q=&category_id=&tag=&limit= — поиск/список опубликованных
router.get('/articles', readAny, async (req, res) => {
  const q         = (req.query.q || '').trim();
  const catId     = req.query.category_id ? parseInt(req.query.category_id, 10) : null;
  const tag       = (req.query.tag || '').trim();
  // limit: typeahead шлёт небольшое число (напр. 8); обычный список — 100
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isInteger(limit) || limit < 1) limit = 100;
  if (limit > 100) limit = 100;
  try {
    const params = [req.user.salonId];
    const where  = ['a.salon_id=$1', 'a.is_published=true'];

    if (catId) { params.push(catId); where.push(`a.category_id=$${params.length}`); }
    if (tag)   { params.push(tag);   where.push(`$${params.length} = ANY(a.tags)`); }

    let rankSelect = 'NULL::real AS rank';
    let snippetSelect = "left(a.body, 200) AS snippet";
    let orderBy = 'a.display_order ASC, a.id ASC';

    if (q) {
      params.push(q);
      const qp = `$${params.length}`;             // сырой ввод для ILIKE
      const tsq = buildPrefixTsQuery(q);          // prefix-tsquery для FTS
      if (tsq) {
        params.push(tsq);
        const tp = `$${params.length}`;
        where.push(`(a.search_vector @@ to_tsquery('russian', ${tp})
                     OR a.title ILIKE '%'||${qp}||'%'
                     OR a.body  ILIKE '%'||${qp}||'%')`);
        rankSelect = `ts_rank(a.search_vector, to_tsquery('russian', ${tp})) AS rank`;
        // Подсветку выделяем безопасными сентинел-маркерами (не HTML). Фронт
        // экранирует весь сниппет, затем заменяет маркеры на <b>/</b> — так тело
        // статьи не может протащить HTML/скрипт в innerHTML (защита от XSS).
        snippetSelect = `ts_headline('russian', a.body, to_tsquery('russian', ${tp}),
                          'StartSel=@@KBH_S@@, StopSel=@@KBH_E@@, MaxWords=30, MinWords=15, ShortWord=2, HighlightAll=false') AS snippet`;
        orderBy = 'rank DESC, a.display_order ASC';
      } else {
        // tsquery пуст (только спецсимволы) → ищем лишь подстрокой ILIKE
        where.push(`(a.title ILIKE '%'||${qp}||'%' OR a.body ILIKE '%'||${qp}||'%')`);
      }
    }

    const rows = await db.any(
      `SELECT a.id, a.category_id, a.title, a.tags, a.display_order,
              ${snippetSelect}, ${rankSelect}
         FROM kb_articles a
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderBy}
        LIMIT ${limit}`,
      params);
    res.json({ articles: rows });
  } catch (e) {
    logger.error(`GET /articles: ${e.message}`);
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});
```

Примечание: `limit` — провалидированное целое `1..100`, интерполяция в SQL безопасна.

- [ ] **Step 3: Проверить синтаксис модуля**

Run: `cd backend && node -e "require('./routes/knowledge-base'); console.log('ok')"`
Expected: печатает `ok` без ошибок.

- [ ] **Step 4: Дымовой тест поиска через рабочий пул БД**

Создать временный `backend/_kbsmoke.js`:

```js
const { db } = require('./db');
const { buildPrefixTsQuery } = require('./services/knowledge-base');
(async () => {
  try {
    const q = '123';                       // префикс существующей тестовой статьи "1234"
    const tsq = buildPrefixTsQuery(q);
    const rows = await db.any(
      `SELECT a.id, a.title, ts_rank(a.search_vector, to_tsquery('russian',$2)) rank
         FROM kb_articles a
        WHERE a.salon_id=1 AND a.is_published=true
          AND (a.search_vector @@ to_tsquery('russian',$2)
               OR a.title ILIKE '%'||$1||'%' OR a.body ILIKE '%'||$1||'%')
        ORDER BY rank DESC, a.display_order ASC LIMIT 8`, [q, tsq]);
    console.log('tsq=', tsq, 'rows=', JSON.stringify(rows));
  } catch (e) { console.error('SMOKE ERR:', e.message); }
  finally { process.exit(0); }
})();
```

Run: `cd backend && node _kbsmoke.js && rm -f _kbsmoke.js`
Expected: `tsq= 123:*` и в `rows` присутствует статья с `title` `"1234"` (префикс срабатывает до допечатывания слова). Затем удалить временный файл.

- [ ] **Step 5: Коммит**

```bash
git add backend/routes/knowledge-base.js
git commit -m "feat(kb): префиксный to_tsquery + limit в поиске статей

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Разметка popup и стили

**Files:**
- Modify: `frontend/index.html:1192-1195` (обёртка + popup), `:16` (версия features.css), `:1883-1884` (версии скриптов)
- Modify: `frontend/css/features.css:497-499` (kb-search/topbar) + новые правила `.kb-suggest*`

- [ ] **Step 1: Обернуть инпут и добавить контейнер popup**

В `frontend/index.html` заменить строки 1192-1195:

```html
        <div class="kb-topbar">
          <input id="kb-search" class="kb-search" type="search" placeholder="Поиск по базе знаний…" autocomplete="off">
          <button id="kb-add-article" class="btn-pri kb-admin-only" type="button">+ Статья</button>
        </div>
```

на:

```html
        <div class="kb-topbar">
          <div class="kb-search-wrap">
            <input id="kb-search" class="kb-search" type="search" placeholder="Поиск по базе знаний…" autocomplete="off">
            <div id="kb-suggest" class="kb-suggest" hidden></div>
          </div>
          <button id="kb-add-article" class="btn-pri kb-admin-only" type="button">+ Статья</button>
        </div>
```

- [ ] **Step 2: Обновить стили строки поиска и добавить стили popup**

В `frontend/css/features.css` заменить строки 497-499:

```css
.kb-topbar { display: flex; gap: 12px; margin-bottom: 16px; }
.kb-search { flex: 1; padding: 12px 16px; font-size: 16px; border-radius: 12px;
  border: 1px solid var(--border, #ddd); background: var(--card, #fff); color: inherit; }
```

на:

```css
.kb-topbar { display: flex; gap: 12px; margin-bottom: 16px; }
.kb-search-wrap { position: relative; flex: 1; min-width: 0; }
.kb-search { width: 100%; padding: 12px 16px; font-size: 16px; border-radius: 12px;
  border: 1px solid var(--border, #ddd); background: var(--card, #fff); color: inherit; }
.kb-suggest { position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 1200;
  background: var(--card, #fff); border: 1px solid var(--border, #ddd); border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0,0,0,.18); max-height: 60vh; overflow-y: auto; padding: 6px; }
.kb-suggest[hidden] { display: none; }
.kb-suggest-item { padding: 10px 12px; border-radius: 8px; cursor: pointer; }
.kb-suggest-item:hover, .kb-suggest-item.active { background: var(--hover, #f2f2f7); }
.kb-suggest-title { font-weight: 600; margin-bottom: 2px; }
.kb-suggest-snippet { font-size: 13px; opacity: .75; overflow: hidden; text-overflow: ellipsis;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.kb-suggest-snippet b { background: rgba(255,214,0,.4); }
.kb-suggest-empty { padding: 14px 12px; text-align: center; opacity: .6; font-size: 14px; }
```

- [ ] **Step 3: Сбросить кеш — версии CSS и JS**

В `frontend/index.html` строка 16 — заменить:

```html
<link rel="stylesheet" href="css/features.css?v=2026-07-16-kb">
```

на:

```html
<link rel="stylesheet" href="css/features.css?v=2026-07-16-kb2">
```

И строки 1883-1884 — заменить:

```html
<script src="js/pages/kb-markdown.js"></script>
<script src="js/pages/knowledge-base.js"></script>
```

на:

```html
<script src="js/pages/kb-markdown.js?v=2026-07-16-kb2"></script>
<script src="js/pages/knowledge-base.js?v=2026-07-16-kb2"></script>
```

- [ ] **Step 4: Проверить разметку**

Run: `grep -n "kb-search-wrap\|kb-suggest\|kb-2026-07-16-kb2\|features.css?v=2026-07-16-kb2" frontend/index.html frontend/css/features.css`
Expected: присутствуют `.kb-search-wrap`, `#kb-suggest`, `.kb-suggest*` в CSS и обновлённые версии в index.html.

- [ ] **Step 5: Коммит**

```bash
git add frontend/index.html frontend/css/features.css
git commit -m "feat(kb): разметка и стили выпадающего typeahead-поиска

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Логика typeahead во фронтенде

**Files:**
- Modify: `frontend/js/pages/knowledge-base.js` (глобальные переменные, `kbBindOnce`, новые функции `kbTypeahead`/`kbRenderSuggest`/`kbHideSuggest`/`kbMoveActive`)

- [ ] **Step 1: Добавить состояние typeahead**

В `frontend/js/pages/knowledge-base.js` после строки 6 (`let _kbSearchTimer = null;`) добавить:

```js
let _kbSuggestSeq = 0;         // токен «последнего запроса» — защита от гонки ответов
let _kbSuggestItems = [];      // текущие статьи в popup
let _kbSuggestActive = -1;     // индекс подсвеченной строки (-1 = нет)
```

- [ ] **Step 2: Переключить обработчик ввода на typeahead и добавить закрытие popup**

Заменить тело `kbBindOnce` (строки 27-46) на:

```js
let _kbBound = false;
function kbBindOnce() {
  if (_kbBound) return; _kbBound = true;

  const input = document.getElementById('kb-search');
  input.addEventListener('input', () => {
    clearTimeout(_kbSearchTimer);
    _kbSearchTimer = setTimeout(kbTypeahead, 180);
  });
  input.addEventListener('keydown', (ev) => {
    const box = document.getElementById('kb-suggest');
    if (box.hidden) return;
    if (ev.key === 'ArrowDown')      { ev.preventDefault(); kbMoveActive(1); }
    else if (ev.key === 'ArrowUp')   { ev.preventDefault(); kbMoveActive(-1); }
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      const pick = _kbSuggestActive >= 0 ? _kbSuggestActive : 0;
      const art = _kbSuggestItems[pick];
      if (art) { kbHideSuggest(); kbOpenArticle(art.id); }
    } else if (ev.key === 'Escape') { kbHideSuggest(); }
  });
  // клик вне строки поиска — закрыть popup
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.kb-search-wrap')) kbHideSuggest();
  });

  document.getElementById('kb-add-article').addEventListener('click', () => kbOpenArticleModal(null));

  // делегирование: клики по кнопкам копирования внутри статьи
  document.getElementById('kb-content').addEventListener('click', (ev) => {
    const copy = ev.target.closest('.kb-copy');
    if (copy) {
      const code = copy.parentElement.querySelector('code');
      if (code) navigator.clipboard.writeText(code.innerText).then(() => {
        copy.textContent = '✓'; setTimeout(() => (copy.textContent = '⧉'), 1200);
      });
    }
  });
}
```

- [ ] **Step 3: Добавить функции typeahead**

Сразу после `kbBindOnce` (перед `function renderKbFolders`) добавить:

```js
function kbHideSuggest() {
  const box = document.getElementById('kb-suggest');
  box.hidden = true; box.innerHTML = '';
  _kbSuggestItems = []; _kbSuggestActive = -1;
}

function kbRenderSuggest(arts) {
  const box = document.getElementById('kb-suggest');
  _kbSuggestItems = arts; _kbSuggestActive = -1;
  if (!arts.length) {
    box.innerHTML = `<div class="kb-suggest-empty">Ничего не найдено</div>`;
    box.hidden = false; return;
  }
  box.innerHTML = arts.map((a, i) => `
    <div class="kb-suggest-item" data-i="${i}" data-id="${a.id}">
      <div class="kb-suggest-title">${kbEsc(a.title)}</div>
      <div class="kb-suggest-snippet">${kbSnippet(a.snippet)}</div>
    </div>`).join('');
  box.hidden = false;
  box.querySelectorAll('.kb-suggest-item').forEach(el =>
    el.addEventListener('click', () => {
      const id = parseInt(el.dataset.id, 10);
      kbHideSuggest(); kbOpenArticle(id);
    }));
}

function kbMoveActive(dir) {
  const items = document.querySelectorAll('#kb-suggest .kb-suggest-item');
  if (!items.length) return;
  _kbSuggestActive = (_kbSuggestActive + dir + items.length) % items.length;
  items.forEach((el, i) => el.classList.toggle('active', i === _kbSuggestActive));
  items[_kbSuggestActive].scrollIntoView({ block: 'nearest' });
}

async function kbTypeahead() {
  const q = document.getElementById('kb-search').value.trim();
  if (q.length < 2) { kbHideSuggest(); return; }
  const seq = ++_kbSuggestSeq;
  try {
    const data = await api('GET', '/api/kb/articles?q=' + encodeURIComponent(q) + '&limit=8');
    if (seq !== _kbSuggestSeq) return;          // пришёл устаревший ответ — игнор
    kbRenderSuggest(data.articles || []);
  } catch (e) {
    if (seq === _kbSuggestSeq) kbHideSuggest(); // ошибку в popup не показываем
  }
}
```

Примечание: `kbEsc`, `kbSnippet`, `api`, `kbOpenArticle` уже определены (глобальные); `kbRunSearch` (просмотр папки в теле страницы) и клик по папке в `renderKbFolders` остаются без изменений.

- [ ] **Step 4: Проверить синтаксис JS**

Run: `node --check frontend/js/pages/knowledge-base.js && echo ok`
Expected: печатает `ok`.

- [ ] **Step 5: Коммит**

```bash
git add frontend/js/pages/knowledge-base.js
git commit -m "feat(kb): живой typeahead-поиск с popup, клавиатурой и защитой от гонки

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Проверка вживую в браузере + фиксация токена

**Files:** нет правок кода (только верификация); при находках — точечный фикс в затронутых файлах.

- [ ] **Step 1: Убедиться, что dev-сервер поднят и отдаёт свежие ассеты**

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/api/app-settings`
Expected: `200`. Если сервер отдаёт старый код — `pm2 restart loyalpro` (гоча `PORT`: см. [[dev-db-access-tunnel]] — `unset PORT` перед `--update-env`).

- [ ] **Step 2: Открыть страницу под токеном owner (ключ localStorage `lp_tk`)**

Использовать браузер MCP: перейти на `http://localhost:3001`, установить `localStorage.setItem('lp_tk', '<token>')` (валидный токен минтится скриптом из сессии; должен быть в таблице `sessions`), перезагрузить, открыть раздел «База знаний».

- [ ] **Step 3: Проверить typeahead**

Набрать в строке поиска префикс `123` (в dev есть статья `"1234"`). Ожидается: под строкой появляется popup со строкой-статьёй `1234` с подсвеченным фрагментом; клик по строке открывает статью в `#kb-content`. Проверить: `↓/↑` двигают активную строку, `Enter` открывает активную, `Esc` и клик вне строки закрывают popup, ввод <2 символов popup прячет.

- [ ] **Step 4: Проверить консоль браузера на ошибки**

Ожидается: нет ошибок JS (особенно `kbTypeahead`/`kbSnippet`/`api`).

- [ ] **Step 5 (при находках): точечный фикс + коммит**

Если что-то не работает — исправить в соответствующем файле, повторить Step 3, затем:

```bash
git add -A
git commit -m "fix(kb): <что починили> по результатам live-проверки

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Заметки по завершении

- После верификации — предложить пользователю мерж/PR ветки `feature/knowledge-base` (skill `finishing-a-development-branch`).
- Обновить память `[[dev-db-access-tunnel]]`, если процедура минта токена/логина под токеном изменится.
