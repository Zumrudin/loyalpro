# Экономика: схемы оплаты труда (переработка модуля «Оплата труда»)

Дата: 2026-10-19. Статус: дизайн на согласование. Заменяет §3.3 спеки
`2026-10-18-procedure-economics-design.md` (плоские правила `staff_pay_rules`).

## 1. Зачем

Сегодня оплата врача задаётся плоскими правилами: одно правило = одна услуга ИЛИ одна
категория (+ необязательно сотрудник) с процентом, базой и периодом. Чтобы описать
оплату одного врача по 8 категориям и 5 услугам, нужно 13 правил, и повторить их для
второго врача с такой же схемой — ещё 13. Владелец хочет:

- создать **схему оплаты** один раз: внутри выбрать несколько категорий и/или услуг
  и назначить им процент, базу (с вычетом материалов или без) и коэффициент ФОТ;
- **назначить** схему специалисту (и ту же схему — нескольким);
- приоритет: услуга, названная в схеме прямо, важнее категории, в которую она входит
  («Инъекционная косметология» 15 % с чека, но «Revi Strong 2 ml» — 15 % с вычетом
  материалов).

## 2. Модель данных

Две новые таблицы (`migrations.js`, только `IF NOT EXISTS`, `salon_id` везде).

```
pay_schemes
  id          SERIAL PK
  salon_id    INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE
  title       VARCHAR(120) NOT NULL
  note        VARCHAR(500)
  lines       JSONB NOT NULL DEFAULT '[]'
  created_at / updated_at TIMESTAMPTZ
  INDEX (salon_id)

pay_scheme_assignments
  id          SERIAL PK
  salon_id    INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE
  staff_yc_id BIGINT NOT NULL
  scheme_id   INT NOT NULL REFERENCES pay_schemes(id) ON DELETE RESTRICT
  valid_from  DATE            -- NULL = с начала времён
  valid_to    DATE            -- NULL = бессрочно
  note        VARCHAR(500)
  created_at / updated_at TIMESTAMPTZ
  INDEX (salon_id, staff_yc_id)
```

Элемент `lines` (линия схемы):

```json
{ "percent": 15, "base": "gross" | "net_of_materials",
  "payroll_multiplier": null | 1.0–3.0,
  "fixed_per_visit": 0,
  "categories": [9536366, 15394116], "services": [15394061] }
```

- `payroll_multiplier` — коэффициент ФОТ линии; `null` = множитель из настроек салона
  (`economics_settings.payroll_multiplier`, как сейчас).
- `fixed_per_visit` — сохраняется из текущей модели («как сейчас»): фикс за визит,
  делится между услугами одной записи, попавшими под одну линию.
- Линия **без целей** (`categories` и `services` пусты) — «остальные услуги» схемы:
  применяется ко всему, что не покрыто другими линиями. В схеме такая линия не более
  одной. Схема без неё оставляет непокрытые услуги без оплаты (флаг `no_pay_rule`,
  как сейчас у сотрудника без правила).

Инварианты схемы (проверяются в `parsePayScheme` на бэкенде и зеркально на фронте):

- 1–50 линий; `percent` 0–100; `base` из двух значений; `payroll_multiplier` null или
  1–3; `fixed_per_visit` 0–10 000 000; id — целые положительные;
- одна услуга не может стоять в двух линиях; одна категория — в двух линиях
  (иначе выбор неоднозначен → 400 с указанием, что именно продублировано);
- услуга в одной линии и её категория в другой — ЗАКОННО, это и есть приоритет;
- не более одной линии без целей.

Инварианты назначений: у одного сотрудника периоды назначений не пересекаются
(открытые границы считаются бесконечностью); `scheme_id` принадлежит тому же салону.

Старая таблица `staff_pay_rules` остаётся в БД (правило проекта «никогда
деструктивно»), но кодом больше не читается; ручки `/pay-rules` удаляются (модуль
не на проде, на деве два правила — см. §7).

## 3. Выбор линии и расчёт (`services/economics/pay-rules.js`, чистый модуль)

```
resolvePay({ assignments, schemes }, { staffId, serviceId, categoryId, date })
  → { schemeId, lineIdx, line } | null
```

1. Назначение: строки `assignments` с `staff_yc_id = staffId`, действующие на `date`
   (`valid_from <= date <= valid_to`, NULL — без границы). Несколько (не должно быть,
   но данные могли разойтись) → самое позднее `valid_from`, затем больший `id`.
   Нет назначения → `null`.
2. Схема по `scheme_id`; нет в карте (удалена/чужая) → `null`.
3. Линия, по приоритету: `services` содержит `serviceId` → `categories` содержит
   `categoryId` → линия без целей → `null`.

```
doctorPay(row, line, settings)   // row: {price, revenue, materials_used}
  mult  = line.payroll_multiplier > 0 ? line.payroll_multiplier : settings.payroll_multiplier
  start = settings.pay_base_includes_bonuses ? price : revenue
  base  = line.base === 'net_of_materials' ? start − materials_used : start
  pay   = max(0, base) × percent / 100 + fixed_per_visit
  cost  = pay × mult
```

Формула и флаг `pay_base_includes_bonuses` — без изменений; меняется только источник
множителя (линия → салон).

`calc.js`: вместо `pickRule` — `resolvePay`; группировка фикса за визит внутри записи —
по ключу `${schemeId}:${lineIdx}` (раньше — по `rule.id`). В строке отчёта поля
`pay_rule_id` больше нет; вместо него `pay_scheme_id` и `pay_line_idx` (null при
`no_pay_rule`). `report.js` пробрасывает их в `serviceDetail`. Контекст расчёта
(`ctx.payRules`) заменяется на `ctx.pay = { assignments, schemes }`; `store.loadContext`
грузит обе таблицы салона.

`payrollCheck` (сверка с YClients) не меняется: он суммирует `doctor_pay` по строкам.

## 4. API (`routes/economics.js`, только owner)

```
GET    /api/economics/pay-schemes
       → { schemes:[{id,title,note,lines,assigned:[staff_yc_id…]}],
           assignments:[{id,staff_yc_id,scheme_id,valid_from,valid_to,note}] }
POST   /api/economics/pay-schemes            { title, note, lines }        → { id }
PUT    /api/economics/pay-schemes/:id        { title, note, lines }        → { ok }
DELETE /api/economics/pay-schemes/:id        → { ok } | 409 «схема назначена специалистам»
POST   /api/economics/pay-assignments        { staffYcId, schemeId, validFrom, validTo, note } → { id }
PUT    /api/economics/pay-assignments/:id    то же                           → { ok }
DELETE /api/economics/pay-assignments/:id    → { ok }
```

- `parsePayScheme(body)` и `parsePayAssignment(body)` — функции уровня модуля (как
  `parsePayRule`/`parseRuleBody`), юнит-тесты без HTTP.
- Проверка пересечения периодов — чистая `assignmentsOverlap(existing, candidate)` в
  `pay-rules.js`, маршрут читает назначения сотрудника и исключает редактируемую строку.
- Любая мутация → `report.invalidate(salonId)` (как сейчас у правил).
- Удаление схемы при живых назначениях — 409, а не каскад: оплата — деньги, молча
  обнулить расчёт по врачу нельзя.

## 5. Фронт — вкладка «Оплата труда» (`frontend/js/pages/economics.js`)

Три блока сверху вниз.

**Схемы оплаты.** Список карточек: название, число линий, кому назначена (имена из
справочника `staff`), «Изменить», «Удалить», сверху «+ Схема». Редактор схемы
(inline-карточка, как сейчас у правила): название, заметка, список линий, «+ Линия».
Линия: процент, база (select), коэффициент ФОТ (пусто = из настроек; подпись
показывает текущее значение настроек), фикс за визит, два мультивыбора — категории и
услуги. Мультивыбор: поле поиска + выпадающий список с чекбоксами, выбранное —
чипами с крестиком; у услуги в списке показывается её категория. Линия без выбранных
целей подписывается «остальные услуги». Под редактором подсказка о приоритете
(услуга > категория > остальные). Конфликты (услуга/категория в двух линиях)
подсвечиваются до отправки.

**Назначение специалистам.** Таблица назначений: сотрудник, схема, период, заметка,
«Изменить»/«Удалить»; сверху «+ Назначить» (сотрудник из справочника, схема из списка,
период). Под таблицей строка «без схемы: Имя, Имя…» — активные сотрудники справочника
без действующего на сегодня назначения (это те, у кого в отчёте будет `no_pay_rule`).

**Сверка с YClients** — без изменений.

Чистые помощники в `economics-table.js` (покрыты `node --test`):
`ecoParseSchemeForm` (форма → тело запроса, ошибки на русском), `ecoSchemeConflicts`
(дубли услуг/категорий между линиями, вторая линия без целей), `ecoLineText` (подпись
линии в карточке: «15 % от выручки · ФОТ ×1,494 · 3 категории, 2 услуги»),
`ecoAssignmentsOverlap` (зеркало серверной проверки). Прежние `ecoParseRuleForm` /
`ecoRuleScopeParts` удаляются вместе с тестами. Правка JS — с бампом `?v=`.

## 6. Тесты

- `economics-pay-rules.test.js` — переписать: `resolvePay` (нет назначения; период
  назначения; услуга бьёт категорию; категория бьёт «остальные»; «остальные» бьёт
  null; удалённая схема → null; два назначения → позднее), `doctorPay` (множитель линии
  vs салона, обе базы, фикс), `assignmentsOverlap` (открытые границы).
- `economics-calc.test.js` — фикстуры с `ctx.pay`, проверка `pay_scheme_id`/`pay_line_idx`
  и деления фикса по линии.
- `economics-routes.test.js` — `parsePayScheme` (все инварианты §2),
  `parsePayAssignment`.
- `economics-store.test.js` — SQL новых функций; после правок — живой EXPLAIN не нужен
  (простые выборки по `salon_id`).
- `economics-report.test.js` — поле `pay_scheme_id` в `serviceDetail`.
- `frontend/js/pages/economics-table.test.js` — новые помощники.
- Живая проверка на деве: создать схему по §7, сверить вкладку «Услуги» и «Сверка с
  YClients» за сентябрь с цифрами до переработки (ожидается совпадение `doctor_pay`
  по врачу 5708379 за месяцы, где обе категории действовали).

## 7. Перенос данных

Автоматического переноса из `staff_pay_rules` нет: прода у модуля нет, на деве два
правила одного врача (5708379): категория 9536366 — 15 % с 01.02.2026, категория
15394116 — 20 % с 01.05.2026. Разные даты начала у линий в новой модели выражаются
двумя назначениями: схема «А» (одна линия, 15 %) с 01.02 по 30.04 и схема «Б» (обе
линии) с 01.05. Заводится руками после выката. Если точность по весне не нужна —
одна схема «Б» с 01.02 (тогда за февраль–апрель вторая категория будет оплачена, чего
в старых правилах не было).

## 8. Вне рамок

- Ступенчатые проценты от оборота за месяц, оклады, KPI — не просил.
- Перенос коэффициента ФОТ на уровень схемы (только линия и салон).
- Импорт схем из YClients «Расчёт зарплат» (у YClients свои схемы, API их не отдаёт
  в пригодном виде; сверка по итогам остаётся).
- Проверка пересечения периодов на уровне БД (`EXCLUDE` требует `btree_gist`; код
  проверяет сам, как у «Заботы»).
