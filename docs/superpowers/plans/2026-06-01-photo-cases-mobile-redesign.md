# Фото-кейсы — редизайн (мобильный + десктоп) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перевести страницу «Фото-кейсы» staff-фронта на визуальный язык «A · Чистая клиника» со сравнением «До → После», на всех трёх уровнях (лента, пациент, альбом), с сохранением тёмной темы.

**Architecture:** Чистая правка представления. Бэкенд получает один pure-helper (`stageFlags`) + два поля в ответах. Фронт переписывает HTML-разметку трёх рендер-функций в `frontend/js/pages/patient-portfolio.js` и блок стилей `#page-patient-portfolio` в `frontend/css/base.css`. Вся логика (загрузка с прогрессом, лайтбокс, заметки, комментарии, удаление, навигация) сохраняется — меняются разметка и стили.

**Tech Stack:** Vanilla JS SPA (без сборки, правки живут на reload), Express, CSS-переменные тем, Jest (бэкенд-юнит), MCP Playwright (визуальная проверка).

**Дизайн-спека:** `docs/superpowers/specs/2026-06-01-photo-cases-mobile-redesign-design.md`

**Среда проверки:** dev-сервер `http://localhost:3001` (PM2 `loyalpro`, фронт отдаётся статикой — reload без рестарта). Вход owner. Бэкенд-правки требуют `pm2 restart loyalpro`. Все браузерные проверки — **только** через MCP Playwright (`mcp__playwright__*`), скриншоты класть в `/root/loyalpro/.playwright-mcp/`. БД-запросы — только через `mcp__postgres__query` (read-only).

---

## Файлы

- `backend/services/patient-portfolio.js` — +pure-helper `stageFlags(photos)`; экспорт.
- `backend/patient-portfolio-helpers.test.js` — +юнит-тесты `stageFlags`.
- `backend/routes/patient-portfolio.js` — `GET /visits/recent` и `GET /clients/:clientId/cases`: выставить `has_before/has_after` в существующем цикле; в `/cases` добавить `client_name/client_phone` через `JOIN clients`.
- `frontend/js/pages/patient-portfolio.js` — переписать разметку `_ppRenderFeed` (L1), `_ppRenderPatient` (L2), `_ppRenderAlbum` (L3); +`_ppInitials`; +`_ppState.clientName`.
- `frontend/css/base.css` — заменить блок правил `#page-patient-portfolio` и обновить мобильные медиа-запросы.

---

## Task 1: Бэкенд — флаги стадий и имя пациента

**Files:**
- Modify: `backend/services/patient-portfolio.js` (после `pickThumbForCard`, ~стр. 33; и `module.exports`, ~стр. 122)
- Test: `backend/patient-portfolio-helpers.test.js`
- Modify: `backend/routes/patient-portfolio.js` (`/clients/:clientId/cases` ~стр. 96–115; `/visits/recent` ~стр. 138–144)

- [ ] **Step 1: Написать падающий тест `stageFlags`**

Добавить в конец `backend/patient-portfolio-helpers.test.js`:

```js
describe('stageFlags', () => {
  const { stageFlags } = require('./services/patient-portfolio');
  const photo = (stage) => ({ stage });
  test('обе стадии присутствуют', () => {
    expect(stageFlags([photo('before'), photo('after')])).toEqual({ has_before: true, has_after: true });
  });
  test('только before', () => {
    expect(stageFlags([photo('before'), photo('in_progress')])).toEqual({ has_before: true, has_after: false });
  });
  test('только after', () => {
    expect(stageFlags([photo('after')])).toEqual({ has_before: false, has_after: true });
  });
  test('пусто/не массив', () => {
    expect(stageFlags([])).toEqual({ has_before: false, has_after: false });
    expect(stageFlags(null)).toEqual({ has_before: false, has_after: false });
  });
});
```

- [ ] **Step 2: Запустить тест — должен упасть**

Run: `cd /root/loyalpro/backend && npx jest patient-portfolio-helpers`
Expected: FAIL — `stageFlags is not a function`.

- [ ] **Step 3: Реализовать `stageFlags`**

В `backend/services/patient-portfolio.js` сразу после функции `pickThumbForCard` (после строки `}` на ~стр. 33) вставить:

```js
// Флаги для бейджа «До·После» в ленте/карточке. photos: [{stage}].
function stageFlags(photos) {
  const arr = Array.isArray(photos) ? photos : [];
  return {
    has_before: arr.some(p => p.stage === 'before'),
    has_after:  arr.some(p => p.stage === 'after'),
  };
}
```

В `module.exports` (~стр. 122) добавить `stageFlags,` в список (например сразу после `pickThumbForCard,`):

```js
module.exports = {
  buildS3Key,
  parseStage,
  normalizePhone,
  pickThumbForCard,
  stageFlags,
  assertCanMutate,
  ForbiddenError,
  processAndUpload,
  processS3Orphans,
};
```

- [ ] **Step 4: Запустить тест — должен пройти**

Run: `cd /root/loyalpro/backend && npx jest patient-portfolio-helpers`
Expected: PASS (все suites зелёные, включая новый `stageFlags`).

- [ ] **Step 5: Прокинуть флаги в `/visits/recent`**

В `backend/routes/patient-portfolio.js` найти цикл в `/visits/recent` (~стр. 138–143):

```js
  for (const v of rows) {
    const photos = await db.any(
      `SELECT id, stage, s3_key_thumb FROM case_photos WHERE case_visit_id=$1`, [v.id]);
    const pick = svc.pickThumbForCard(photos);
    v.preview_url = pick ? await s3.presignGet(pick.s3_key_thumb) : null;
  }
```

Заменить на (добавлена строка с флагами):

```js
  for (const v of rows) {
    const photos = await db.any(
      `SELECT id, stage, s3_key_thumb FROM case_photos WHERE case_visit_id=$1`, [v.id]);
    const pick = svc.pickThumbForCard(photos);
    v.preview_url = pick ? await s3.presignGet(pick.s3_key_thumb) : null;
    Object.assign(v, svc.stageFlags(photos));
  }
```

- [ ] **Step 6: Прокинуть флаги + имя пациента в `/clients/:clientId/cases`**

В том же файле, в `/clients/:clientId/cases`, в SQL (~стр. 96–107) добавить JOIN+поля. Найти:

```js
  const rows = await db.any(`
    SELECT v.*, u.name AS specialist_name,
           c.title AS course_title,
           (SELECT COUNT(*)::int FROM case_photos p WHERE p.case_visit_id = v.id) AS photos_count,
           (SELECT COUNT(*)::int FROM case_comments cm WHERE cm.case_visit_id = v.id) AS comments_count
    FROM case_visits v
    LEFT JOIN users u ON u.id = v.specialist_user_id
    LEFT JOIN case_courses c ON c.id = v.course_id
    WHERE ${where}
    ORDER BY v.visit_date DESC, v.id DESC
    LIMIT $${params.length}
  `, params);
```

Заменить на:

```js
  const rows = await db.any(`
    SELECT v.*, u.name AS specialist_name,
           c.title AS course_title,
           cl.name AS client_name, cl.phone AS client_phone,
           (SELECT COUNT(*)::int FROM case_photos p WHERE p.case_visit_id = v.id) AS photos_count,
           (SELECT COUNT(*)::int FROM case_comments cm WHERE cm.case_visit_id = v.id) AS comments_count
    FROM case_visits v
    LEFT JOIN users u ON u.id = v.specialist_user_id
    LEFT JOIN case_courses c ON c.id = v.course_id
    JOIN clients cl ON cl.id = v.client_id
    WHERE ${where}
    ORDER BY v.visit_date DESC, v.id DESC
    LIMIT $${params.length}
  `, params);
```

И цикл ниже (~стр. 109–114):

```js
  for (const v of rows) {
    const photos = await db.any(
      `SELECT id, stage, s3_key_thumb FROM case_photos WHERE case_visit_id=$1`, [v.id]);
    const pick = svc.pickThumbForCard(photos);
    v.preview_url = pick ? await s3.presignGet(pick.s3_key_thumb) : null;
  }
```

Заменить на:

```js
  for (const v of rows) {
    const photos = await db.any(
      `SELECT id, stage, s3_key_thumb FROM case_photos WHERE case_visit_id=$1`, [v.id]);
    const pick = svc.pickThumbForCard(photos);
    v.preview_url = pick ? await s3.presignGet(pick.s3_key_thumb) : null;
    Object.assign(v, svc.stageFlags(photos));
  }
```

- [ ] **Step 7: Рестарт и проверка API**

Run: `pm2 restart loyalpro && sleep 2 && pm2 logs loyalpro --lines 5 --nostream`
Expected: процесс `online`, в логах нет ошибок старта.

Проверить форму ответа (через MCP Playwright `browser_evaluate` после входа owner, либо через уже залогиненную сессию):
```js
() => fetch('/api/patient-portfolio/visits/recent?limit=3', {headers:{Authorization:'Bearer '+localStorage.getItem('lp_tk')}}).then(r=>r.json()).then(a=>a.map(v=>({id:v.id,has_before:v.has_before,has_after:v.has_after})))
```
Expected: массив, у каждого элемента есть булевы `has_before`/`has_after`.

- [ ] **Step 8: Полный прогон затронутых тестов и коммит**

Run: `cd /root/loyalpro/backend && npx jest patient-portfolio-helpers patient-portfolio-pipeline portfolio`
Expected: все PASS.

```bash
cd /root/loyalpro
git add backend/services/patient-portfolio.js backend/patient-portfolio-helpers.test.js backend/routes/patient-portfolio.js
git commit -m "feat(photo-cases): stageFlags helper + has_before/has_after + client name on cases

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: CSS — новый визуальный язык `#page-patient-portfolio`

**Files:**
- Modify: `frontend/css/base.css` (блок правил `#page-patient-portfolio`, ~стр. 246–319; и мобильные медиа-запросы ~стр. 415–424)

> CSS-классы должны совпадать с разметкой из Task 3–4. Этот таск только добавляет/заменяет стили — визуально полностью проявится после Task 3. Юнит-тестов у CSS нет; проверка — что страница не сломалась и существующая разметка не «поехала».

- [ ] **Step 1: Заменить блок стилей**

В `frontend/css/base.css` заменить весь непрерывный блок правил `#page-patient-portfolio` — от первого правила `#page-patient-portfolio .pp-search{...}` (≈стр. 246) до последнего `#page-patient-portfolio .pp-add-disabled{...}` (≈стр. 319) — на следующий блок целиком:

```css
/* ════ Фото-кейсы — оформление (направление «A · Чистая клиника») ════ */
/* L1 поиск + сетки */
#page-patient-portfolio .pp-search{display:flex;gap:10px;align-items:center;padding:14px 0 12px}
#page-patient-portfolio .pp-q{flex:1;padding:10px 14px;border:1px solid var(--bd);border-radius:10px;font-size:14px;background:var(--bg);color:var(--t1);min-width:0}
#page-patient-portfolio .pp-create-btn{white-space:nowrap;padding:10px 16px}
#page-patient-portfolio .pp-feed{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;padding:4px 0}
#page-patient-portfolio .pp-recent,#page-patient-portfolio .pp-search-results{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}

/* карточки общие */
#page-patient-portfolio .case-card{border:1px solid var(--bd);border-radius:var(--r);cursor:pointer;background:var(--card);box-shadow:var(--sh);transition:transform .12s,box-shadow .12s;overflow:hidden}
#page-patient-portfolio .case-card:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(0,0,0,.10)}
#page-patient-portfolio .pp-pick,#page-patient-portfolio .pp-search-results .case-card{padding:12px 14px}
#page-patient-portfolio .cc-name{font-weight:700;font-size:14px;color:var(--t1)}
#page-patient-portfolio .cc-meta{color:var(--t3);font-size:12.5px;margin-top:4px}
#page-patient-portfolio .cc-course{color:var(--a);font-size:12px;margin-top:4px;font-weight:600}

/* L1 плитки ленты */
#page-patient-portfolio .pp-tile{padding:0}
#page-patient-portfolio .pp-tile-media{position:relative}
#page-patient-portfolio .cc-preview{display:block;width:100%;height:150px;object-fit:cover;background:var(--bg)}
#page-patient-portfolio .cc-noimg{width:100%;height:150px;background:var(--bg);display:grid;place-items:center;color:var(--t3);font-size:12px}
#page-patient-portfolio .pp-ba-badge{position:absolute;top:8px;right:8px;background:var(--grad-a);color:#fff;font-size:11px;font-weight:600;padding:3px 9px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.18)}
#page-patient-portfolio .pp-tile .cc-body{padding:10px 13px}

/* подсказки/пустые */
#page-patient-portfolio .pp-hint,#page-patient-portfolio .pp-empty{color:var(--t3);padding:16px 0;font-size:13px}
#page-patient-portfolio .pp-stage-empty{color:var(--t3);font-size:12px;padding:10px 14px}

/* тулбар */
#page-patient-portfolio .pp-toolbar{display:flex;gap:8px;padding:10px 0 14px;align-items:center}
#page-patient-portfolio .btn-back{background:none;border:0;color:var(--a);cursor:pointer;padding:6px 8px;font-size:14px;font-weight:600}
#page-patient-portfolio .btn-back:hover{text-decoration:underline}

/* L2 шапка пациента */
#page-patient-portfolio .pp-patient-head{display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--card);border:1px solid var(--bd);border-radius:var(--r);box-shadow:var(--sh);margin-bottom:12px}
#page-patient-portfolio .pp-avatar{width:46px;height:46px;border-radius:50%;background:var(--grad-a);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex-shrink:0}
#page-patient-portfolio .pp-patient-name{font-weight:700;font-size:16px;color:var(--t1)}
#page-patient-portfolio .pp-patient-sub{font-size:12.5px;color:var(--t3);margin-top:2px}

/* L2 чипы курсов */
#page-patient-portfolio .pp-courses-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
#page-patient-portfolio .pp-chip{font-size:12px;font-weight:600;border-radius:20px;padding:5px 12px;cursor:pointer;white-space:nowrap}
#page-patient-portfolio .pp-chip-course{background:var(--as);color:var(--a)}
#page-patient-portfolio .pp-chip-add{background:var(--bg);color:var(--t2);border:1px dashed var(--bd)}
#page-patient-portfolio .pp-chip-add:hover{color:var(--t1)}

/* L2 ряды альбомов */
#page-patient-portfolio .pp-timeline{display:flex;flex-direction:column;gap:10px}
#page-patient-portfolio .pp-row{display:flex;align-items:stretch}
#page-patient-portfolio .pp-row-img{width:72px;height:72px;object-fit:cover;flex-shrink:0;background:var(--bg)}
#page-patient-portfolio .pp-row-noimg{width:72px;height:72px;flex-shrink:0;background:var(--bg);display:grid;place-items:center;color:var(--t3);font-size:10px}
#page-patient-portfolio .pp-row-body{padding:10px 13px}

/* L3 заголовок альбома + меню ⋯ */
#page-patient-portfolio .pp-album-meta{flex:1;font-weight:700;font-size:14px;color:var(--t1)}
#page-patient-portfolio .pp-menu{position:relative}
#page-patient-portfolio .pp-menu-btn{background:none;border:0;font-size:22px;line-height:1;color:var(--t3);cursor:pointer;padding:4px 10px;border-radius:8px}
#page-patient-portfolio .pp-menu-btn:hover{background:var(--bg);color:var(--t1)}
#page-patient-portfolio .pp-menu-pop{position:absolute;right:0;top:110%;background:var(--card);border:1px solid var(--bd);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:6px;z-index:50;min-width:160px}
#page-patient-portfolio .pp-menu-pop[hidden]{display:none}
#page-patient-portfolio .pp-del-visit{display:block;width:100%;text-align:left;background:none;border:0;color:var(--danger);font-size:13px;padding:8px 10px;border-radius:7px;cursor:pointer}
#page-patient-portfolio .pp-del-visit:hover{background:rgba(232,84,84,.10)}

/* L3 сравнение До/После */
#page-patient-portfolio .pp-compare{margin:0 0 14px;border:1px solid var(--bd);border-radius:var(--r);overflow:hidden;background:var(--card);box-shadow:0 2px 12px rgba(0,200,150,.12)}
#page-patient-portfolio .pp-cmp-pair{display:grid;grid-template-columns:1fr 1fr;gap:2px;background:var(--bd)}
#page-patient-portfolio .pp-cmp-half{position:relative;margin:0;background:var(--bg)}
#page-patient-portfolio .pp-cmp-half img{display:block;width:100%;height:220px;object-fit:cover;cursor:pointer}
#page-patient-portfolio .pp-cmp-lbl{position:absolute;top:8px;font-size:11px;font-weight:600;color:#fff;padding:2px 8px;border-radius:7px}
#page-patient-portfolio .pp-cmp-before{left:8px;background:rgba(0,0,0,.55)}
#page-patient-portfolio .pp-cmp-after{right:8px;background:var(--grad-a)}
#page-patient-portfolio .pp-cmp-foot{padding:8px 12px;font-size:12px;font-weight:600;color:var(--a)}

/* L3 карточки стадий */
#page-patient-portfolio .pp-stage{margin:0 0 14px;background:var(--card);border:1px solid var(--bd);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden}
#page-patient-portfolio .pp-stage--after{border-color:var(--a)}
#page-patient-portfolio .pp-stage--after::before{content:"";display:block;height:3px;background:var(--grad-a)}
#page-patient-portfolio .pp-stage-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px}
#page-patient-portfolio .pp-stage-head h3{margin:0;font-size:13px;color:var(--t1);font-weight:700}
#page-patient-portfolio .pp-stage-count{display:inline-block;margin-left:6px;padding:1px 8px;background:var(--bg);border-radius:10px;font-size:11px;color:var(--t3)}
#page-patient-portfolio .pp-stage--after .pp-stage-count{background:var(--as);color:var(--a)}
#page-patient-portfolio .pp-add-btn{cursor:pointer;color:var(--a);font-size:13px;font-weight:600}
#page-patient-portfolio .pp-add-btn:hover{text-decoration:underline}
#page-patient-portfolio .pp-stage-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:0 4px 4px}
#page-patient-portfolio .pp-thumb{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;cursor:pointer;background:var(--bg);transition:transform .12s}
#page-patient-portfolio .pp-thumb:hover{transform:scale(1.03)}

/* L3 дропзона пустой стадии */
#page-patient-portfolio .pp-dropzone{display:flex;flex-direction:column;align-items:center;gap:4px;margin:0 14px 14px;padding:20px;border:1.5px dashed var(--bd);border-radius:12px;color:var(--t3);font-size:12px;cursor:pointer;text-align:center}
#page-patient-portfolio .pp-dropzone:hover{border-color:var(--a);color:var(--a)}
#page-patient-portfolio .pp-dz-plus{font-size:24px;line-height:1}

/* прогресс загрузки (логика без изменений) */
#page-patient-portfolio .pp-upload-bar{display:flex;align-items:center;gap:10px;margin:0 14px 12px}
#page-patient-portfolio .pp-upload-bar[hidden]{display:none}
#page-patient-portfolio .pp-upload-track{flex:1;height:6px;background:var(--bg);border-radius:3px;overflow:hidden}
#page-patient-portfolio .pp-upload-fill{height:100%;width:0;background:var(--grad-a);border-radius:3px;transition:width .2s ease}
#page-patient-portfolio .pp-upload-label{font-size:12px;color:var(--t2);white-space:nowrap;min-width:96px;text-align:right}
#page-patient-portfolio .pp-add-disabled{pointer-events:none;opacity:.5}

/* заметки / комментарии */
#page-patient-portfolio .pp-notes,#page-patient-portfolio .pp-comments{padding:14px;margin:0 0 14px;background:var(--card);border:1px solid var(--bd);border-radius:var(--r);box-shadow:var(--sh)}
#page-patient-portfolio .pp-notes h3,#page-patient-portfolio .pp-comments h3{margin:0 0 10px;font-size:13px;color:var(--t1);font-weight:700}
#page-patient-portfolio .pp-notes-ta{width:100%;min-height:72px;padding:10px;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--t1);font-family:inherit;font-size:13px;resize:vertical}
#page-patient-portfolio .pp-notes-hint{font-size:11px;color:var(--t3);margin-top:4px}
#page-patient-portfolio .pp-comment{padding:10px 0;border-bottom:1px solid var(--bd)}
#page-patient-portfolio .pp-c-head{font-size:11px;color:var(--t3)}
#page-patient-portfolio .pp-c-text{margin-top:4px;white-space:pre-wrap;font-size:13px;color:var(--t1)}
#page-patient-portfolio .pp-comment-form{display:flex;gap:8px;align-items:flex-start;margin-top:12px}
#page-patient-portfolio .pp-new-comment{flex:1;min-height:48px;padding:8px;border:1px solid var(--bd);border-radius:8px;font-family:inherit;font-size:13px;resize:vertical;background:var(--bg);color:var(--t1)}

/* модалка создания альбома (L1) */
#page-patient-portfolio .pp-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.55);display:grid;place-items:center;z-index:9998;padding:20px}
#page-patient-portfolio .pp-modal-bg[hidden]{display:none !important}
#page-patient-portfolio .pp-modal{background:var(--card);border-radius:var(--r);width:min(560px,100%);max-height:80vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.25)}
#page-patient-portfolio .pp-modal-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--bd)}
#page-patient-portfolio .pp-modal-head h3{margin:0;font-size:16px;color:var(--t1)}
#page-patient-portfolio .pp-modal-close{background:none;border:0;font-size:24px;line-height:1;cursor:pointer;color:var(--t3);padding:0 6px}
#page-patient-portfolio .pp-modal-close:hover{color:var(--t1)}
#page-patient-portfolio .pp-modal-body{padding:14px 18px;overflow:auto;display:flex;flex-direction:column;gap:12px}
#page-patient-portfolio .pp-create-q{padding:10px 14px;border:1px solid var(--bd);border-radius:8px;font-size:14px;background:var(--bg);color:var(--t1)}
#page-patient-portfolio .pp-create-results{display:flex;flex-direction:column;gap:8px}

/* лайтбокс */
#page-patient-portfolio .pp-lightbox{position:fixed;inset:0;background:rgba(0,0,0,.88);display:grid;place-items:center;z-index:9999}
#page-patient-portfolio .pp-lightbox[hidden]{display:none !important}
#page-patient-portfolio .pp-lb-img{max-width:92vw;max-height:86vh;object-fit:contain;border-radius:4px}
#page-patient-portfolio .pp-lb-close{position:absolute;top:14px;right:18px;font-size:36px;line-height:1;background:none;color:#fff;border:0;cursor:pointer;padding:0 8px}
#page-patient-portfolio .pp-lb-dl{position:absolute;bottom:24px;left:50%;transform:translateX(-50%);padding:8px 18px}

/* десктоп: миниатюры фикс-размера, выше hero-сравнение */
@media(min-width:701px){
  #page-patient-portfolio .pp-stage-grid{grid-template-columns:repeat(auto-fill,120px)}
  #page-patient-portfolio .pp-cmp-half img{height:300px}
}
```

- [ ] **Step 2: Обновить мобильные медиа-запросы**

Найти блок (≈стр. 415–424):

```css
@media(max-width:700px){
  .modal{width:100%;max-width:100%;max-height:92vh;border-radius:16px 16px 0 0;padding:16px;transform:translateY(8px)}
  .ov.open .modal{transform:translateY(0)}  /* выезд снизу вместо scale-пульсации */
  .ov{align-items:flex-end}                 /* модалка прижата к низу (bottom-sheet) */
  .g3,.g32,.g2{grid-template-columns:1fr}   /* любые многоколоночные сетки → 1 колонка */
  #page-patient-portfolio .pp-grid{grid-template-columns:1fr}  /* детальный вид кейса: сайдбар над контентом */
}
@media(max-width:480px){
  #page-patient-portfolio .pp-feed{grid-template-columns:1fr}   /* фото-кейсы в 1 колонку на узких */
}
```

Заменить на (убрана мёртвая `.pp-grid`-строка — сайдбар курсов заменён на чипы в Task 4):

```css
@media(max-width:700px){
  .modal{width:100%;max-width:100%;max-height:92vh;border-radius:16px 16px 0 0;padding:16px;transform:translateY(8px)}
  .ov.open .modal{transform:translateY(0)}  /* выезд снизу вместо scale-пульсации */
  .ov{align-items:flex-end}                 /* модалка прижата к низу (bottom-sheet) */
  .g3,.g32,.g2{grid-template-columns:1fr}   /* любые многоколоночные сетки → 1 колонка */
}
@media(max-width:480px){
  #page-patient-portfolio .pp-feed{grid-template-columns:1fr}   /* фото-кейсы в 1 колонку на узких */
}
```

- [ ] **Step 3: Проверить, что страница не сломалась (MCP Playwright)**

С уже залогиненной сессии owner: `browser_resize` 390×844, `browser_navigate` `http://localhost:3001/`, затем `browser_evaluate`: `() => { const el=document.querySelector('.tn[data-p="patient-portfolio"]'); if(el) nav(el); return 'ok'; }`. Сделать `browser_take_screenshot` ленты.
Expected: лента рендерится без визуальных артефактов; плитки в карточках с тенью и скруглением; нет «голых» неоформленных блоков. (Бейдж «До·После» и новые L2/L3 появятся после Task 3–4 — здесь проверяем только что старая разметка не «поехала».)

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro
git add frontend/css/base.css
git commit -m "feat(photo-cases): new clinical-clean visual system (CSS)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: L3 Альбом — разметка, сравнение, дропзоны, меню ⋯

**Files:**
- Modify: `frontend/js/pages/patient-portfolio.js` (`_ppRenderAlbum` ~стр. 308–478)

> Сохранить ВСЕ обработчики: удаление (теперь в меню ⋯), автосохранение заметок, загрузка с прогрессом, лайтбокс, комментарии. Меняются: тулбар (меню ⋯), добавлена карточка-сравнение, карточки стадий с дропзонами.

- [ ] **Step 1: Заменить тело `_ppRenderAlbum`**

Заменить функцию `_ppRenderAlbum` целиком (от `async function _ppRenderAlbum() {` до её закрывающей `}` перед `function _ppBack`) на:

```js
async function _ppRenderAlbum() {
  let v;
  try {
    v = await api('GET', `/api/patient-portfolio/visits/${_ppState.visitId}`);
  } catch (e) {
    _ppRoot().innerHTML = `<div class="pp-hint" style="color:#c00">Ошибка загрузки: ${_ppEsc(e.message)}</div>`;
    return;
  }
  const byStage = { before: [], in_progress: [], after: [] };
  v.photos.forEach(p => { if (byStage[p.stage]) byStage[p.stage].push(p); });

  // Карточка-сравнение: первое (старейшее) «до» + последнее (новейшее) «после».
  // photos с сервера упорядочены stage, sort_order, id — внутри стадии массив по возрастанию.
  const cmpBefore = byStage.before[0];
  const cmpAfter  = byStage.after[byStage.after.length - 1];
  const compareBlock = (cmpBefore && cmpAfter) ? `
    <section class="pp-compare">
      <div class="pp-cmp-pair">
        <figure class="pp-cmp-half">
          <img class="pp-thumb" src="${_ppEsc(cmpBefore.url_thumb)}" data-photo-id="${cmpBefore.id}" data-medium="${_ppEsc(cmpBefore.url_medium)}" alt="">
          <figcaption class="pp-cmp-lbl pp-cmp-before">ДО</figcaption>
        </figure>
        <figure class="pp-cmp-half">
          <img class="pp-thumb" src="${_ppEsc(cmpAfter.url_thumb)}" data-photo-id="${cmpAfter.id}" data-medium="${_ppEsc(cmpAfter.url_medium)}" alt="">
          <figcaption class="pp-cmp-lbl pp-cmp-after">ПОСЛЕ</figcaption>
        </figure>
      </div>
      <div class="pp-cmp-foot">Результат</div>
    </section>
  ` : '';

  const fileInput = (key) => `<input type="file" accept="image/jpeg,image/png,image/webp" multiple data-stage="${key}" hidden>`;

  const stageBlock = (key) => {
    const photos = byStage[key];
    const body = photos.length === 0
      ? `<label class="pp-dropzone">
           <span class="pp-dz-plus">＋</span>
           <span>${_PP_STAGE_LABELS[key]} — добавить фото</span>
           ${fileInput(key)}
         </label>`
      : `<div class="pp-stage-grid">
           ${photos.map(p => `<img class="pp-thumb" src="${_ppEsc(p.url_thumb)}" data-photo-id="${p.id}" data-medium="${_ppEsc(p.url_medium)}" alt="">`).join('')}
         </div>`;
    return `
      <section class="pp-stage pp-stage--${key}">
        <header class="pp-stage-head">
          <h3>${_PP_STAGE_LABELS[key]} <span class="pp-stage-count">${photos.length}</span></h3>
          ${photos.length ? `<label class="pp-add-btn">+ Добавить фото${fileInput(key)}</label>` : ''}
        </header>
        <div class="pp-upload-bar" hidden>
          <div class="pp-upload-track"><div class="pp-upload-fill"></div></div>
          <span class="pp-upload-label"></span>
        </div>
        ${body}
      </section>
    `;
  };

  _ppRoot().innerHTML = `
    <div class="pp-toolbar">
      <button class="btn-back" onclick="_ppBack(2)">‹ Пациент</button>
      <div class="pp-album-meta">Альбом · ${_ppEsc(_ppFmtDate(v.visit_date))}</div>
      <div class="pp-menu">
        <button class="pp-menu-btn" type="button" aria-label="Меню альбома">⋯</button>
        <div class="pp-menu-pop" hidden>
          <button class="pp-del-visit" type="button">Удалить альбом</button>
        </div>
      </div>
    </div>
    ${compareBlock}
    ${stageBlock('before')}
    ${stageBlock('in_progress')}
    ${stageBlock('after')}
    <section class="pp-notes">
      <h3>Заметки</h3>
      <textarea class="pp-notes-ta" placeholder="Клинические заметки по альбому">${_ppEsc(v.notes || '')}</textarea>
      <div class="pp-notes-hint">Сохраняется при потере фокуса</div>
    </section>
    <section class="pp-comments">
      <h3>Комментарии</h3>
      <div class="pp-comments-list">
        ${v.comments.length === 0 ? '<div class="pp-stage-empty">Комментариев пока нет</div>' :
          v.comments.map(c => `
            <div class="pp-comment">
              <div class="pp-c-head">${_ppEsc(c.author_name || '—')} • ${new Date(c.created_at).toLocaleString('ru')}</div>
              <div class="pp-c-text">${_ppEsc(c.text)}</div>
            </div>`).join('')}
      </div>
      <div class="pp-comment-form">
        <textarea class="pp-new-comment" placeholder="Написать комментарий…"></textarea>
        <button class="btn btn-pri pp-add-comment">Отправить</button>
      </div>
    </section>
    <div class="pp-lightbox" hidden>
      <img class="pp-lb-img" alt="">
      <button class="pp-lb-close" type="button">×</button>
      <button class="pp-lb-dl btn btn-pri" type="button">Скачать оригинал</button>
    </div>
  `;

  // ── Меню ⋯ (открыть/закрыть; клик вне — закрыть)
  const menuBtn = _ppRoot().querySelector('.pp-menu-btn');
  const menuPop = _ppRoot().querySelector('.pp-menu-pop');
  menuBtn.onclick = (ev) => { ev.stopPropagation(); menuPop.hidden = !menuPop.hidden; };
  document.addEventListener('click', function closeMenu(ev) {
    if (!_ppRoot() || !_ppRoot().contains(menuPop)) { document.removeEventListener('click', closeMenu); return; }
    if (!menuPop.hidden && ev.target !== menuBtn && !menuPop.contains(ev.target)) menuPop.hidden = true;
  });

  // ── Удаление альбома (пункт меню)
  _ppRoot().querySelector('.pp-del-visit').onclick = async () => {
    if (!confirm('Удалить альбом со всеми фото безвозвратно?')) return;
    try {
      await api('DELETE', `/api/patient-portfolio/visits/${v.id}`);
      _ppState.level = 2; _ppState.visitId = null; _ppRender();
    } catch (e) { alert('Не удалось удалить: ' + e.message); }
  };

  // ── Автосохранение заметок
  _ppRoot().querySelector('.pp-notes-ta').addEventListener('blur', async (e) => {
    if (e.target.value === (v.notes || '')) return;
    try { await api('PUT', `/api/patient-portfolio/visits/${v.id}`, { notes: e.target.value }); }
    catch (err) { alert('Не удалось сохранить заметки: ' + err.message); }
  });

  // ── Загрузка (батчи по 5, multipart, XHR — реальный прогресс + устойчивость к обрыву)
  _ppRoot().querySelectorAll('input[type=file][data-stage]').forEach(inp => {
    inp.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files);
      if (!files.length) return;
      const stage = inp.dataset.stage;
      const section = inp.closest('.pp-stage');
      const bar = section.querySelector('.pp-upload-bar');
      const fill = bar.querySelector('.pp-upload-fill');
      const label = bar.querySelector('.pp-upload-label');
      const addBtn = section.querySelector('.pp-add-btn');

      const total = files.length;
      let done = 0;
      let failed = 0;
      const setBar = (frac, pct) => {
        fill.style.width = Math.min(100, Math.round(pct)) + '%';
        label.textContent = `Загрузка ${Math.min(done + frac, total)} из ${total}…`;
      };
      bar.hidden = false;
      if (addBtn) addBtn.classList.add('pp-add-disabled');
      inp.disabled = true;
      setBar(0, 0);

      try {
        for (let i = 0; i < files.length; i += 5) {
          const chunk = files.slice(i, i + 5);
          const body = await _ppUploadChunk(v.id, stage, chunk, (chunkFrac) => {
            setBar(Math.round(chunkFrac * chunk.length), ((done + chunkFrac * chunk.length) / total) * 100);
          });
          const ups = Array.isArray(body.uploaded) ? body.uploaded : [];
          failed += chunk.length - ups.filter(u => u && u.ok).length;
          done += chunk.length;
          setBar(0, (done / total) * 100);
        }
        fill.style.width = '100%';
        label.textContent = failed ? `Готово · ${failed} не удалось` : 'Готово';
        if (failed) {
          alert(`Загружено ${total - failed} из ${total}. ${failed} фото не удалось обработать — попробуйте добавить их ещё раз.`);
          _ppRender();
        } else {
          setTimeout(() => _ppRender(), 450);
        }
      } catch (err) {
        alert('Ошибка загрузки: ' + err.message + (done ? `\nЗагружено ${done} из ${total} до обрыва.` : ''));
        _ppRender();
      }
    });
  });

  // ── Лайтбокс (покрывает и миниатюры стадий, и половинки сравнения — класс .pp-thumb)
  const lb = _ppRoot().querySelector('.pp-lightbox');
  _ppRoot().querySelectorAll('.pp-thumb').forEach(img => {
    img.onclick = () => {
      lb.hidden = false;
      lb.querySelector('.pp-lb-img').src = img.dataset.medium;
      lb.dataset.photoId = img.dataset.photoId;
    };
  });
  const closeLightbox = () => { lb.hidden = true; };
  lb.querySelector('.pp-lb-close').onclick = closeLightbox;
  lb.addEventListener('click', (ev) => { if (ev.target === lb) closeLightbox(); });
  document.addEventListener('keydown', function escClose(ev) {
    if (ev.key === 'Escape' && !lb.hidden) closeLightbox();
  });
  lb.querySelector('.pp-lb-dl').onclick = async () => {
    try {
      const r = await api('GET', `/api/patient-portfolio/photos/${lb.dataset.photoId}/url?variant=original`);
      window.open(r.url, '_blank');
    } catch (e) { alert('Не удалось получить ссылку: ' + e.message); }
  };

  // ── Добавление комментария
  _ppRoot().querySelector('.pp-add-comment').onclick = async () => {
    const ta = _ppRoot().querySelector('.pp-new-comment');
    const text = ta.value.trim();
    if (!text) return;
    try {
      await api('POST', `/api/patient-portfolio/visits/${v.id}/comments`, { text });
      ta.value = '';
      _ppRender();
    } catch (e) { alert('Не удалось отправить: ' + e.message); }
  };
}
```

- [ ] **Step 2: Проверить альбом визуально (MCP Playwright, 390×844)**

Войти owner, перейти на «Фото-кейсы», открыть альбом, где есть и «до», и «после» (если такого нет — открыть любой и загрузить по 1 фото в «До» и в «После»). `browser_take_screenshot` (fullPage).
Expected:
- Тулбар: «‹ Пациент» · «Альбом · <дата>» (в одну строку) · кнопка «⋯» справа.
- Вверху — карточка-сравнение: слева фото с меткой «ДО», справа с «ПОСЛЕ» (градиентная плашка), подпись «Результат».
- Карточки стадий: «ПОСЛЕ» с верхней градиентной полосой и бирюзовым чипом-счётчиком.
- Пустая стадия «В процессе» → дашед-дропзона с «＋» (а не серый текст «Нет фото»).
- `browser_console_messages` без ошибок.

- [ ] **Step 3: Проверить интерактив**

- Клик «⋯» → выпадает меню с «Удалить альбом»; клик вне — закрывается.
- Клик по половине сравнения и по миниатюре стадии → открывается лайтбокс; «×» и клик по фону закрывают.
- Клик по дашед-дропзоне открывает системный выбор файла (в Playwright — появляется file chooser; можно проверить, что у инпута `data-stage` совпадает со стадией).
Expected: всё перечисленное работает; ошибок в консоли нет.

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro
git add frontend/js/pages/patient-portfolio.js
git commit -m "feat(photo-cases): redesigned album — compare card, stage cards, dropzones, overflow menu

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: L1 Лента + L2 Карточка пациента — разметка

**Files:**
- Modify: `frontend/js/pages/patient-portfolio.js` (`_ppState` ~стр. 4; `_ppRenderFeed` ~стр. 133–167; `_ppDoSearch` click-handler ~стр. 195–200; `_ppRenderPatient` ~стр. 204–249; +`_ppInitials`)

- [ ] **Step 1: Добавить `clientName` в состояние и хелпер инициалов**

Заменить строку 4:

```js
const _ppState = { level: 1, clientId: null, visitId: null };
```

на:

```js
const _ppState = { level: 1, clientId: null, visitId: null, clientName: null };
```

И сразу после неё (перед `const _ppEsc`) добавить:

```js
// Инициалы для аватара пациента: «Иванова Ася» → «ИА».
const _ppInitials = (name) => String(name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '—';
```

- [ ] **Step 2: Сохранять имя пациента при переходе из поиска в L2**

В `_ppDoSearch` найти обработчик клика по результату (~стр. 195–200):

```js
  out.querySelectorAll('.case-card').forEach(el => {
    el.addEventListener('click', () => {
      _ppState.level = 2; _ppState.clientId = parseInt(el.dataset.clientId);
      _ppRender();
    });
  });
```

Заменить на (добавить `data-client-name` в разметку результата и читать его):

```js
  out.querySelectorAll('.case-card').forEach(el => {
    el.addEventListener('click', () => {
      _ppState.level = 2;
      _ppState.clientId = parseInt(el.dataset.clientId);
      _ppState.clientName = el.dataset.clientName || null;
      _ppRender();
    });
  });
```

И в той же функции в шаблоне результатов (~стр. 189–194) добавить атрибут `data-client-name`. Найти:

```js
    <div class="case-card" data-client-id="${c.id}">
      <div class="cc-name">${_ppEsc(c.name)}</div>
```

Заменить на:

```js
    <div class="case-card" data-client-id="${c.id}" data-client-name="${_ppEsc(c.name)}">
      <div class="cc-name">${_ppEsc(c.name)}</div>
```

- [ ] **Step 3: Переписать плитки ленты `_ppRenderFeed` (бейдж «До·После»)**

В `_ppRenderFeed` найти присваивание `out.innerHTML = visits.map(...)` (~стр. 149–158):

```js
  out.innerHTML = visits.map(v => `
    <div class="case-card pp-tile" data-visit-id="${v.id}" data-client-id="${v.client_id}">
      ${v.preview_url ? `<img class="cc-preview" src="${_ppEsc(v.preview_url)}" alt="">` : '<div class="cc-noimg">нет фото</div>'}
      <div class="cc-body">
        <div class="cc-name">${_ppEsc(v.client_name || '—')}</div>
        <div class="cc-meta">${_ppEsc(_ppFmtDate(v.visit_date))} • ${v.photos_count} фото${v.comments_count ? ' • ' + v.comments_count + ' комм.' : ''}</div>
        ${v.course_title ? `<div class="cc-course">↳ ${_ppEsc(v.course_title)}</div>` : ''}
      </div>
    </div>
  `).join('');
```

Заменить на:

```js
  out.innerHTML = visits.map(v => `
    <div class="case-card pp-tile" data-visit-id="${v.id}" data-client-id="${v.client_id}">
      <div class="pp-tile-media">
        ${v.preview_url ? `<img class="cc-preview" src="${_ppEsc(v.preview_url)}" alt="">` : '<div class="cc-noimg">нет фото</div>'}
        ${(v.has_before && v.has_after) ? '<span class="pp-ba-badge">До·После</span>' : ''}
      </div>
      <div class="cc-body">
        <div class="cc-name">${_ppEsc(v.client_name || '—')}</div>
        <div class="cc-meta">${_ppEsc(_ppFmtDate(v.visit_date))} • ${v.photos_count} фото${v.comments_count ? ' • ' + v.comments_count + ' комм.' : ''}</div>
        ${v.course_title ? `<div class="cc-course">↳ ${_ppEsc(v.course_title)}</div>` : ''}
      </div>
    </div>
  `).join('');
```

- [ ] **Step 4: Переписать `_ppRenderPatient` (шапка + чипы + ряды)**

Заменить блок `_ppRoot().innerHTML = \`...\`;` внутри `_ppRenderPatient` (~стр. 215–246, от `_ppRoot().innerHTML = ` до закрывающего `;` шаблона) на:

```js
  const pname = (cases[0] && cases[0].client_name) || _ppState.clientName || '—';
  const pphone = (cases[0] && cases[0].client_phone) || '';
  _ppRoot().innerHTML = `
    <div class="pp-toolbar">
      <button class="btn-back" onclick="_ppBack(1)">‹ К поиску</button>
      <button class="btn btn-pri" onclick="_ppNewVisit()">+ Новый альбом</button>
    </div>
    <div class="pp-patient-head">
      <div class="pp-avatar">${_ppEsc(_ppInitials(pname))}</div>
      <div class="pp-patient-id">
        <div class="pp-patient-name">${_ppEsc(pname)}</div>
        <div class="pp-patient-sub">${_ppEsc(pphone)}${cases.length ? ' · ' + cases.length + ' альбом(ов)' : ''}</div>
      </div>
    </div>
    <div class="pp-courses-row">
      ${courses.map(c => `<span class="pp-chip pp-chip-course" data-id="${c.id}">${_ppEsc(c.title)} · ${c.visits.length}</span>`).join('')}
      <span class="pp-chip pp-chip-add" onclick="_ppNewCourse()">+ Курс</span>
    </div>
    <div class="pp-timeline">
      ${cases.length === 0 ? '<div class="pp-empty">Альбомов пока нет — нажмите «+ Новый альбом»</div>' :
        cases.map(v => `
          <div class="case-card pp-row" data-visit-id="${v.id}">
            ${v.preview_url ? `<img class="pp-row-img" src="${_ppEsc(v.preview_url)}" alt="">` : '<div class="pp-row-noimg">нет фото</div>'}
            <div class="pp-row-body">
              <div class="cc-name">${_ppEsc(_ppFmtDate(v.visit_date))}</div>
              <div class="cc-meta">${_ppEsc(v.specialist_name || '—')} • ${v.photos_count} фото • ${v.comments_count} комм.</div>
              ${v.course_title ? `<div class="cc-course">↳ ${_ppEsc(v.course_title)}</div>` : ''}
            </div>
          </div>
        `).join('')}
    </div>
  `;
```

> Обработчик клика по `.case-card[data-visit-id]` ниже по функции (~стр. 247–248) НЕ меняется — он по-прежнему открывает L3.

- [ ] **Step 5: Проверить ленту (MCP Playwright, 390×844)**

Войти owner → «Фото-кейсы». `browser_take_screenshot` ленты.
Expected: плитки с крупным превью; на альбомах, где есть и «до», и «после», в правом верхнем углу превью — градиентный бейдж «До·После»; имя жирное, мета серым. Клик по плитке открывает альбом.

- [ ] **Step 6: Проверить карточку пациента**

Из ленты клик по плитке открывает L3; вернуться нельзя на L2 напрямую — открыть L2 через поиск: ввести в строку поиска ленты имя пациента (≥2 симв.) → клик по результату.
Expected:
- Шапка: круглый аватар с инициалами (градиент), имя, телефон · N альбомов.
- Ряд чипов курсов (бирюзовые) + чип «+ Курс».
- Альбомы — ряды с миниатюрой слева и мета справа; курс зелёным.
- Клик по ряду открывает альбом. Консоль без ошибок.

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro
git add frontend/js/pages/patient-portfolio.js
git commit -m "feat(photo-cases): redesigned feed (before/after badge) + patient view (header, course chips, rows)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Тёмная тема + кросс-уровневая визуальная приёмка

**Files:** проверка; правки только если найдены дефекты (в `frontend/css/base.css`).

- [ ] **Step 1: Тёмная тема — все три уровня (MCP Playwright, 390×844)**

Включить тёмную тему: `browser_evaluate` → `() => { document.documentElement.setAttribute('data-theme','dark'); return document.documentElement.getAttribute('data-theme'); }` (или клик по переключателю темы в топбаре). Сделать скриншоты ленты, карточки пациента и альбома.
Expected: нет блёклых/«выбитых» белых пятен; текст читается (`--t1/--t2/--t3`); карточки на фоне `--card` отделяются от `--bg`; бейдж/чипы/«После»-акцент видны; тинты сравнения не выглядят грязными. Если что-то не читается — добавить переопределения в блок `[data-theme="dark"]` и переустановить (только CSS).

- [ ] **Step 2: Десктоп (≈1280) — светлая тема**

`browser_resize` 1280×900, пройти три уровня.
Expected: лента/результаты — многоколоночная сетка; миниатюры стадий — фикс-размер (`repeat(auto-fill,120px)`), не растянуты во всю ширину; hero-сравнение выше (300px). Тулбары и карточки выровнены.

- [ ] **Step 3: Краевые случаи**

- Альбом только с «До» (нет «после»): карточки-сравнения НЕТ; в ленте у такого альбома НЕТ бейджа «До·После».
- Пустой альбом (0 фото): три дашед-дропзоны, карточки-сравнения нет, страница не падает.
- Пациент без альбомов (через поиск, у кого `cases_count=0`): шапка показывает имя из поиска, «Альбомов пока нет…», чип «+ Курс» работает.
Expected: всё перечисленное соответствует.

- [ ] **Step 4: Регресс загрузки с прогрессом**

Открыть стадию, загрузить 1–2 валидных фото через дашед-дропзону или «+ Добавить фото».
Expected: появляется прогресс-бар (градиентный fill, «Загрузка N из M…»), по завершении «Готово», стадия перерисовывается с миниатюрами; кнопка «+ Добавить фото» дизейблится на время загрузки. (Если тестовые фото добавлялись — удалить их через лайтбокс/`DELETE /photos/:id` или меню, чтобы не засорять данные; не трогать чужие фото.)

- [ ] **Step 5: Финальный прогон бэкенд-тестов**

Run: `cd /root/loyalpro/backend && npx jest patient-portfolio-helpers patient-portfolio-pipeline portfolio`
Expected: все PASS.

- [ ] **Step 6: Commit (если были правки тёмной темы)**

```bash
cd /root/loyalpro
git add frontend/css/base.css
git commit -m "fix(photo-cases): dark-theme polish after visual review

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Если правок не было — пропустить коммит, отметить шаг выполненным.

---

## После всех задач

Запустить **superpowers:finishing-a-development-branch** для завершения работы на ветке `feat/patient-photo-cases` (тесты → варианты merge/PR). Пуш и деплой — на стороне пользователя.
