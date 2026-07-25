# Агент: вложенные подкатегории услуг + перемещение услуг между категориями

Дата: 2026-07-25. Статус: утверждён (автономная реализация).

## Проблема

Экран «Услуги агента» показывает плоское дерево **категория YClients → услуга →
мастера**. Категории приходят живьём из YClients и никак не детализируются. Мила
(`list_services`) получает плоский список услуг без иерархии.

Салону нужна более глубокая детализация каталога, чтобы Мила точнее отвечала на
вопросы по процедурам и препаратам. Пример:

- **Инъекционная косметология** (категория YClients)
  - **Биоревитализация** (подкатегория)
    - **Препараты по лицу** (под-подкатегория) → услуги-препараты
    - **Препараты по телу** → услуги-препараты
  - **Контурная пластика губ** (подкатегория) → услуги

Тогда на вопрос «сколько стоит био?» Мила видит, какие препараты относятся к
биоревитализации (по лицу/по телу), и точно называет диапазон «цена от … до …»,
а на вопрос про конкретный препарат — знает, к какой подкатегории он относится.

## Решение (обзор)

Локальный **оверлей-дерево подкатегорий** поверх плоских YClients-категорий +
**назначение услуг** в подкатегории. YClients остаётся источником истины по
услугам, ценам и топ-категориям; подкатегории и привязки услуг хранятся у нас и
редактируются в админке. Услуга по умолчанию лежит в своей родной
YClients-категории; будучи «помещённой» — показывается в выбранной подкатегории
(это же даёт перемещение между категориями).

## Данные (migrations.js — рядом с agent_service_rules)

### `agent_service_subcategories`
```
id             SERIAL PRIMARY KEY
salon_id       INTEGER REFERENCES salons(id) ON DELETE CASCADE
yc_category_id BIGINT NOT NULL          -- ЯКОРЬ: YClients-топ-категория всего поддерева (денормализовано на всех уровнях)
parent_id      INTEGER NULL REFERENCES agent_service_subcategories(id) ON DELETE CASCADE  -- NULL = прямо под YClients-категорией
title          TEXT NOT NULL
display_order  INTEGER NOT NULL DEFAULT 0
created_at     TIMESTAMP DEFAULT NOW()
updated_at     TIMESTAMP DEFAULT NOW()
```
Индексы: `(salon_id, yc_category_id)`, `(salon_id, parent_id)`.

**Инвариант:** у вложенной подкатегории `yc_category_id` наследуется от родителя
(тот же якорь на всех уровнях поддерева). Так путь категорий строится без обхода
до корня — якорь читается прямо из строки.

### `agent_service_placements`
```
id             SERIAL PRIMARY KEY
salon_id       INTEGER REFERENCES salons(id) ON DELETE CASCADE
yc_service_id  BIGINT NOT NULL
subcategory_id INTEGER NOT NULL REFERENCES agent_service_subcategories(id) ON DELETE CASCADE
display_order  INTEGER NOT NULL DEFAULT 0
created_at     TIMESTAMP DEFAULT NOW()
updated_at     TIMESTAMP DEFAULT NOW()
UNIQUE (salon_id, yc_service_id)         -- услуга помещена максимум в ОДНУ подкатегорию
```
Индекс: `(salon_id, subcategory_id)`. Нет строки placement → услуга в родной
YClients-категории. Удаление подкатегории каскадит placements → услуги
возвращаются в родную категорию. Каскад по услугам не нужен (yc_service_id не FK).

## Чистая логика — `services/agent/category-tree.js` (юнит-тесты)

Без БД/HTTP. По образцу `service-filter.js` / `agent-gate.js`.

```
indexTree(ycCategories, subcats, placements) → {
  ycCatById:      Map<string, {id,title,weight}>,
  subcatById:     Map<string, subcat>,
  placementBySvc: Map<svcIdStr, subcatIdStr>,
}

// Путь категорий услуги сверху вниз (массив названий).
// Помещена в подкатегорию S → [название YClients-категории-якоря S, ...цепочка подкатегорий до S].
// Не помещена → [название родной YClients-категории] или [] если категории нет/не найдена.
categoryPathForService(idx, ycServiceId, nativeCategoryId) → string[]

// Вложенное дерево для админки. Услуга попадает в узел своего эффективного
// расположения (placement-подкатегория, если есть и существует; иначе родная
// YClients-категория; иначе «Без категории»). Пустые подкатегории (только что
// созданные, без услуг) присутствуют в дереве.
buildAdminTree(ycCategories, services, subcats, placements) → [
  { id, title, services:[svc...], subcategories:[
      { id, title, subcategory:true, services:[svc...], subcategories:[ ... ] }
  ] }
]
```
Правила `buildAdminTree`:
- Топ-узлы = объединение YClients-категорий, у которых есть ≥1 эффективная услуга
  ИЛИ ≥1 подкатегория, плюс «Без категории» (услуги с `category_id=null` без
  placement). Сортировка топ-категорий и услуг — по весу (убыв.), затем по
  названию (как сейчас, `byWeightTitle`). Подкатегории — по `display_order`, затем
  по названию.
- Подкатегория-сирота (её `parent_id` указывает на несуществующую строку) —
  трактуется как топ-уровневая под своим `yc_category_id` (защитно, не теряем).
- Услуга с placement на удалённую/чужую подкатегорию → падает в родную категорию.
- Циклы parent_id разрывать через `seen`-множество (не зациклиться).

## Сервис — `services/agent-settings.js`

Новые функции (экспортировать):
- `listSubcategories(salonId)` → строки `agent_service_subcategories` (ORDER BY yc_category_id, display_order, id).
- `addSubcategory(salonId, { ycCategoryId, parentId, title })`:
  - `title` обязательный непустой (trim) → иначе `BAD_TITLE`.
  - Если `parentId` задан — загрузить родителя (тот же salon); нет → `BAD_PARENT`;
    `yc_category_id` = `parent.yc_category_id`.
  - Иначе `ycCategoryId` обязателен (parseInt) → иначе `BAD_CATEGORY`.
  - `display_order` = (max среди сиблингов того же salon/yc_category_id/parent_id) + 1.
  - Вернуть созданную строку.
- `renameSubcategory(salonId, id, title)` — trim, `BAD_TITLE` если пусто; `UPDATE ... updated_at=NOW()` со scope по salon_id; вернуть строку.
- `removeSubcategory(salonId, id)` — `DELETE ... WHERE salon_id=$1 AND id=$2` (каскад детей+placements).
- `reorderSubcategories(salonId, items)` — `items:[{id, displayOrder}]`, батч UPDATE со scope по salon_id.
- `listPlacements(salonId)` → строки `agent_service_placements`.
- `placeService(salonId, { ycServiceId, subcategoryId })`:
  - `ycServiceId` parseInt → `BAD_SERVICE`.
  - `subcategoryId` пустой/null → удалить placement (услуга в родную категорию), вернуть `{ removed:true }`.
  - Иначе проверить, что подкатегория принадлежит salon → нет: `BAD_SUBCATEGORY`.
  - Upsert по `UNIQUE (salon_id, yc_service_id)` (`ON CONFLICT DO UPDATE SET subcategory_id, updated_at`). Вернуть строку.
- `unplaceService(salonId, ycServiceId)` — DELETE placement.
- `loadCategoryTree(salonId)` → `{ subcats, placements }` (кидает при сбое БД).
- `loadCategoryTreeSafe(salonId)` → fail-open `{ subcats:[], placements:[] }`.

`getServicesForAdmin(salonId)` — доработать: после сборки `svcObjs` каждому svc
добавить `subcategory_id` (текущий placement или null), затем вместо ручной
группировки построить дерево через `buildAdminTree(categories, svcObjs, subcats,
placements)`. Вернуть `{ serviceMode: filter.mode, categories: tree }`. Формат
объекта услуги без изменений (yc_id, title, price_min, price_max, active, visible,
staff) + новое поле `subcategory_id`.

## Роуты — `routes/agent-settings.js` (`/api/agent`, owner/admin)

Добавить (reorder объявить **до** `/:id`, как в portfolio):
- `GET  /service-subcategories` → `{ subcategories:[...] }`
- `POST /service-subcategories` `{ ycCategoryId, parentId?, title }` → строка (400 на BAD_TITLE/BAD_PARENT/BAD_CATEGORY).
- `PUT  /service-subcategories/reorder` `{ items:[{id, displayOrder}] }` → `{ ok:true }`
- `PUT  /service-subcategories/:id` `{ title }` → строка (400 BAD_TITLE).
- `DELETE /service-subcategories/:id` → `{ ok:true }`
- `POST /service-placements` `{ ycServiceId, subcategoryId }` (subcategoryId null/пусто → снять placement) → строка/`{removed:true}` (400 BAD_SERVICE/BAD_SUBCATEGORY).
- `DELETE /service-placements/:ycServiceId` → `{ ok:true }`

## Инструмент агента — `list_services` (`services/agent/tools/list-services.js`)

- Достать `categories` из `ycGetServiceCatalog` (сейчас не берётся).
- `const tree = await settings.loadCategoryTreeSafe(salonId);`
- `const idx = categoryTree.indexTree(categories, tree.subcats, tree.placements);`
- Каждому элементу выхода добавить `category_path: categoryTree.categoryPathForService(idx, s.id, s.category_id)`.
  (Убедиться, что `priced`-элементы несут `category_id` — да, из каталога.)
- Фолбэк-ветка (YClients упал / нет компании): `category_path: []`.
- **ВАЖНО для тестов:** загрузку дерева делать через `settings.loadCategoryTreeSafe`
  (мокабельно), НЕ добавлять новые прямые `db.any` в list-services — иначе поедут
  порядко-зависимые моки в `agent-tools.test.js`.

## Системный промпт — `services/agent/system-prompt.js`

Добавить (аддитивно, в блок «РАБОТА С ФАКТАМИ», после строки про `duration_min`,
чтобы не ломать якоря существующих тестов) строку:

> `КАТЕГОРИИ И ПОДКАТЕГОРИИ УСЛУГ. У каждой услуги в list_services есть поле category_path — путь от направления к подкатегории (например ["Инъекционная косметология","Биоревитализация","Препараты по лицу"]). Используй его, когда пациент спрашивает про НАПРАВЛЕНИЕ или ГРУППУ («что входит в биоревитализацию?», «какие препараты для губ?», «сколько стоит био?»): отбери услуги, у которых нужное название есть в category_path, и по ним назови состав и диапазон цены «от {min} до {max} ₽» (мин/макс по этим услугам). Не выдумывай препараты вне list_services.`

Прогнать `agent-system-prompt.test.js` — все существующие якоря должны остаться зелёными.

## Фронтенд — `frontend/js/pages/agent-services-catalog.js`

Рекурсивный рендер дерева: категория → (услуги напрямую) + подкатегории → …
Сохранить существующее: режимы, «показать весь каталог», тумблеры видимости
услуги/категории, чекбоксы пар услуга×мастер, свёртка/развёртка.

Новое:
- Кнопка **«＋ подкатегория»** в шапке каждой категории и каждой подкатегории
  (создать вложенную): `POST /service-subcategories` с `ycCategoryId` (id топ-
  категории; для вложенной — `parentId`).
- На каждой подкатегории — **переименовать** (prompt/inline) → `PUT /:id`, и
  **удалить** → `DELETE /:id` (с подтверждением; услуги вернутся в категорию).
- На каждой услуге — контрол **«переместить»**: `<select>` со списком целей
  (все подкатегории доступных категорий + пункт «↩︎ в корень категории»); при
  изменении → `POST /service-placements` (`subcategoryId` или null). Текущая
  позиция услуги отражается выбранным значением (`subcategory_id`).
- Reorder подкатегорий — по желанию (drag-drop), в v1 допустимо опустить;
  создание/удаление/переименование/перемещение обязательны.
- Тумблер категории (bulk-видимость) должен собирать услуги рекурсивно по всему
  поддереву категории. Счётчик «видимо/всего» — по рекурсивной сумме.
- Обновлять данные через `loadAgentServices()` после каждой мутации.
- Бамп версии скрипта в `frontend/index.html` (`?v=2026-07-25-subcats`).
- CSS: отступ по уровню вложенности подкатегории, кнопки, `<select>` перемещения.
  Стили — в тот же файл, где живут `.as-*` (найти в frontend/css).

## Тесты

- **`agent-category-tree.test.js`** (новый, без БД): `indexTree`,
  `categoryPathForService` (родная категория; помещена в подкатегорию 1 уровня;
  вложенная 2 уровня; помещена в удалённую подкатегорию → фолбэк; нет категории →
  []), `buildAdminTree` (услуги в родной; услуга помещена в подкатегорию; пустая
  подкатегория присутствует; вложенность 2 уровня; «Без категории»; сортировка).
- **`agent-tools.test.js`**: замокать `settings.loadCategoryTreeSafe`
  (добавить в `jest.mock('./services/agent-settings', …)`), в тесте с полным
  `toEqual` (услуга «Ботулинотерапия») добавить `category_path: []`. Остальные
  ассерты (objectContaining / по полям) не трогать.
- **`agent-system-prompt.test.js`**: должен остаться зелёным (аддитивная строка).
- Прогон затронутых наборов: `npx jest agent-category-tree agent-tools agent-system-prompt`.

## Границы v1

- Перемещение услуги — только в подкатегории (или назад в корень родной
  категории). Прямое перемещение услуги в ДРУГУЮ топ-YClients-категорию без
  подкатегории не делаем: цель перемещения — детализация, а якорь подкатегории и
  так может отличаться от родной категории услуги (это допустимо и покрывает кейс).
- Reorder подкатегорий drag-drop — необязателен в v1.
- Мила использует `category_path` из промпта; отдельного tool-обхода дерева не
  вводим (экономия бюджета вызовов инструментов).
