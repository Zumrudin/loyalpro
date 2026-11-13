# Журнал записи: паритет с YClients v1 — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Администратор работает в нашем журнале записи так же, как в журнале YClients (неделя, календарь с загрузкой, перетаскивание и растягивание, цвет/метки/значки, перерывы, печать, мобильный день; в карточке — телефон, комментарий, длительность, смена клиента, удаление, технический перерыв, «не уведомлять», «записать повторно», история изменений, панель клиента), не открывая YClients для рутинных операций.

**Architecture:** Журнал остаётся local-first: всё сохраняется сессией формы (`POST /api/journal/sessions`) в `journal_outbox` и уходит в YClients по кнопке «Отправить в YClients» через `outbox-worker` → `index.mutate`. Сервер получает новые поля сессии `edit`, статус `delete`, флаг уведомления (таблица `journal_record_prefs` + `api_id` пакета для `notifications/enroll.js`), чтения `week/month/history/clients/summary` из зеркала и кэша без YClients. Фронт `frontend/js/pages/journal.js` режется на шесть файлов одной глобальной области (префикс `jr`), затем в них добавляются функции сетки и карточки.

**Tech Stack:** Node.js/Express, pg без ORM, vanilla JS SPA (общая глобальная область, префикс `jr`), Jest (`TZ=Europe/Moscow` через jest.config.js), vm-тесты фронта, puppeteer для браузерной проверки.

**Спека:** `docs/superpowers/specs/2026-11-12-journal-parity-v1-design.md` (пункты — обязательства). Инвентаризация: `docs/2026-11-12-journal-current-inventory.md`. Карта API: `docs/2026-11-12-yclients-api-capability-map.md` §1.

---

## Как запускать

```bash
export PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH
cd /root/loyalpro/backend
# один набор (путь с префиксом backend/ ОБЯЗАТЕЛЕН — голый шаблон «journal» в этой рабочей копии гонит лишнее):
npx jest backend/journal-model --silent
# базовая линия (до начала работ: 26 наборов, 553 теста — все зелёные):
npx jest backend/journal service-catalog finance bonus-ledger --silent
# уведомления (задача 5):
npx jest backend/notifications-enroll --silent
```

- Фронт-тесты журнала — jest-набор `backend/journal-ui.test.js`: он читает файлы `frontend/js/pages/journal*.js` и выполняет их в одном `vm`-контексте (после задачи 1 — ВСЕ шесть файлов подряд, список — константа `JR_FILES` в тесте).
- Любая правка JS/CSS фронта — с бампом `?v=` у этого файла в `frontend/index.html` (иначе браузер возьмёт старый файл из кэша).
- Дев-сервер: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro` (НЕ `--update-env` — ломает порт). БД дева — `loyalpro_test` (`DATABASE_URL` в `backend/.env`). Тестовые записи в YClients — ТОЛЬКО клиент 79200255591, с уборкой.
- Миграции — только в `backend/migrations.js`, рядом с блоком JOURNAL (строки ~2686–2790), только `IF NOT EXISTS`-формы.
- Коммиты — в ветку `feat/journal-local-first` после каждой задачи. Прод не трогаем.

## Общие готчи проекта (прочитать до первой задачи)

1. **Общая глобальная область фронта.** Все `frontend/js/pages/journal*.js` подключены обычными `<script>` и делят ОДНУ глобальную область. Верхнеуровневый `const`/`let` с именем, уже объявленным в другом файле, — `SyntaxError`, который гасит ВЕСЬ файл (страница перестаёт работать). Дубль `function` молча перезаписывает предыдущую. Поэтому в задаче 1 заводится тест «нет дублирующихся верхнеуровневых имён между файлами», и каждое новое имя — с префиксом `jr`/`JR_`.
2. **vm-харнесс `journal-ui.test.js`** — не DOM. `document.getElementById(id)` возвращает заглушку-объект (создаётся на лету, поэтому `jrEl('чтоугодно')` в тесте никогда не `null`), у заглушки `querySelectorAll()` всегда `[]`, нет `querySelector`, `classList`, `style`. `innerHTML` — просто строка. Поэтому логику пишем чистыми функциями (`jrDropCheck`, `jrMonthCells`, `jrHistoryHtml` …), а обработчики проверяем вызовом напрямую (`h.get('jrNoNotify').onchange()`). Глобальные `function` видны как `h.context.имя`, `const` — только через `h.run('имя')`.
3. **`db.one` ≡ `db.oneOrNone`** — оба возвращают `null`, а не бросают. Проверяйте результат явно.
4. **JSONB переставляет ключи.** `steps` пакета — JSONB; черновик шага хранится строкой `draftJson`. Новые параметры шагов (`notifyClient`, `apiId`) НЕ кладём в черновик, который фингерпринтится, если это не нужно (см. задачу 4: `apiId` передаётся в `mutate` отдельным аргументом, а не полем черновика).
5. **Тексты YClients наружу не отдаём**: роутер журнала превращает любую не-`JournalError` в 502 `unavailable`. Новые модули бросают только `m.fail(сообщение, статус, код)`.
6. **Телефон клиента** отдаётся только в `GET /records/:id` (карточка) и `GET /clients/summary`. В `GET /day`/`GET /week` его НЕТ: существующий тест `journal-model.test.js` («`normalizeRecord(record)` не имеет `clientPhone`») это охраняет, и он остаётся зелёным — телефон добавляется опцией `normalizeRecord(r, { withPhone: true })`.
7. **`journal_operations.action` имеет CHECK-ограничение** (`create, move, cancel, confirm, edit`). Шаг `delete` идёт через `index.mutate`, который пишет строку `journal_operations` с `action='delete'` — без расширения ограничения вставка упадёт. Задача 4 добавляет ограничение `_v3` (это отступление от спеки §5 «только CREATE TABLE», вынужденное).
8. **Москва.** Все даты — московские (`TZ=Europe/Moscow` в jest и pm2). Дата-ключи `YYYY-MM-DD` строим через `T12:00:00Z` (как `shiftDate` в `index.js`), не через локальную полночь.

## Карта файлов

### Создаются
| Файл | Ответственность |
|---|---|
| `frontend/js/pages/journal-grid.js` | сетка дня и недели: ячейки (`jrCellState`), дорожки (`jrLayout`), колонка (`jrColumnHtml`), цвет/метки/значки, перерывы, мобильные чипы, неделя, календарь месяца, drag-and-drop и растягивание |
| `frontend/js/pages/journal-card.js` | карточка записи: статусы, услуги, поля паритета (комментарий, длительность, цвет, метки, перерыв, «не уведомлять»), смена клиента, удаление, «Записать повторно», история, панель клиента |
| `frontend/js/pages/journal-forms.js` | формы создания и переноса, поиск клиента, вопрос при закрытии |
| `frontend/js/pages/journal-payment.js` | форма оплаты (перенос без изменений) |
| `frontend/js/pages/journal-dispatch.js` | «Отправить в YClients», сверка операций |
| `backend/services/journal/record-prefs.js` | `journal_record_prefs`: запись флага, чтение, решение «не уведомлять» для вебхука (`optOutForEvent`), `apiIdFor` |
| `backend/services/journal/month.js` | `GET /month`: `monthRange`, `density`, `monthDays`, `month` |
| `backend/services/journal/history.js` | `GET /records/:id/history`: `diffRecords`, `mergeHistory`, `load` |
| `backend/services/journal/client-summary.js` | `GET /clients/summary`: клиент, визиты, бонусы, абонементы (кэш 60 с) |
| `backend/journal-month.test.js`, `backend/journal-history.test.js`, `backend/journal-client-summary.test.js`, `backend/journal-record-prefs.test.js`, `backend/journal-yclients-remove.test.js` | тесты новых модулей |
| `backend/scripts/journal-ui-e2e.js` | браузерная проверка (puppeteer), ничего не пишет в YClients |

### Изменяются
| Файл | Что меняется |
|---|---|
| `frontend/js/pages/journal.js` | остаётся ядро: состояние, `jrApi`, `loadJournal` (день/неделя), навигация, вид, модалка, `jrSave` |
| `frontend/css/journal.css` | цвет/метки/значки, перерывы, печать, неделя, месяц, мобильный день (≤700px), drag, поля карточки, история, панель клиента |
| `frontend/index.html` | теги `<script>` шести файлов (сейчас строка ~3047), тулбар журнала (строки ~437–448): «День/Неделя», «Календарь», «Печать», контейнеры `#jrMonth`, `#jrStaffChips` |
| `backend/services/journal/model.js` | `normalizeRecord` (новые поля, опция `withPhone`), `normColor`, `normalizeLabels`, `recordExtras`, `slotsFor` (технический перерыв), `parseDraft` (`notifyClient`) |
| `backend/services/journal/reference-cache.js` | вид `labels` |
| `backend/services/journal/sources.js` | `labels()` у live/local |
| `backend/services/journal/index.js` | `day` (+labels), `week`, `weekStart`, `detail` (телефон, `notifyClient`), `availability` (`durationOverride`, `technicalBreak`), `prepare`/`mutate` (`delete`, `apiId`, сохранение цвета/меток/перерыва) |
| `backend/services/journal/record-edit.js` | `parse`/`patch`: comment, seanceLength, client, customColor, labelIds, technicalBreak, notifyClient |
| `backend/services/journal/sessions.js` | `status:'delete'`, `edit`+`delete`, проверки, наложение новых полей |
| `backend/services/journal/overlay.js` | применение новых полей и `deleted` |
| `backend/services/journal/yclients.js` | `remove()` — `DELETE /record` |
| `backend/services/journal/outbox-worker.js` | шаг `delete`, `apiId` для create, запись `journal_record_prefs` |
| `backend/services/notifications/events.js` | `apiId` в снимке записи |
| `backend/services/notifications/enroll.js` | причина `journal_opt_out` |
| `backend/migrations.js` | `journal_record_prefs`, ограничение `journal_operations_action_v3_check` |
| `backend/routes/journal.js` | `GET /week`, `/month`, `/records/:id/history`, `/clients/summary` |
| существующие тесты | `journal-ui`, `journal-model`, `journal-reference-cache`, `journal-service`, `journal-sessions`, `journal-record-edit`, `journal-overlay`, `journal-outbox-worker`, `journal-routes`, `journal-local-ddl`, `notifications-enroll` |

## Порядок, зависимости и исполнители

| Задача | Исполнитель | Зависит от |
|---|---|---|
| T1 Разрезание `journal.js` | Sonnet | — |
| T2 `normalizeRecord`, метки, телефон | Sonnet | — |
| T3 Поля сессии `edit` (3a, 3b, 3c) | Opus | T2 |
| T4 Удаление записи, `api_id` | Opus | T3 |
| T5 «Не уведомлять клиента» | Opus | T4 |
| T6 `GET /week`, `GET /month` | Sonnet | T2 |
| T7 История изменений (сервер) | Sonnet | T2 |
| T8 Панель клиента (сервер) | Sonnet | — |
| T9 Сетка: цвет, метки, значки, перерывы, печать | Sonnet | T1, T2 |
| T10 Сетка: неделя, календарь, мобильный день | Sonnet | T6, T9 |
| T11 Сетка: перетаскивание и растягивание | Opus | T3, T10 |
| T12 Карточка: поля паритета, удаление, повтор | Sonnet | T1, T2, T3, T4, T5 |
| T13 Карточка: история и панель клиента | Sonnet | T7, T8, T12 |
| T14 Браузерная проверка + чек-лист живого прогона | Sonnet (скрипт), старшая модель/человек (живой прогон) | все |

Серверные задачи T2–T8 независимы от фронтовых и могут идти параллельно с T1. Фронтовые T9–T13 — строго после T1 (иначе правки придётся переносить между файлами). После каждой задачи — базовая линия зелёная (число тестов только растёт).

---
### Task 1: Разрезание `frontend/js/pages/journal.js` на шесть файлов без изменения поведения

**Исполнитель:** Sonnet. **Зависимости:** нет.

**Files:**
- Modify: `frontend/js/pages/journal.js` (останется только ядро)
- Create: `frontend/js/pages/journal-grid.js`, `journal-card.js`, `journal-forms.js`, `journal-payment.js`, `journal-dispatch.js`
- Modify: `frontend/index.html:3047` (один `<script>` → шесть)
- Test: `backend/journal-ui.test.js` (строки 1–18, 79–86 не трогаем, 279–282, 701–707)

Распределение верхнеуровневых объявлений (имена — из текущего файла):

| Файл | Объявления |
|---|---|
| `journal.js` | `journal`, `jrEl`, `jrEscape`, `jrToday`, `JR_PX_PER_MIN`, `jrMinutes`, `jrTimeLabel`, `jrStatus`, `jrApi`, `loadJournal`, `jrClock`, `jrFreshnessText`, `jrSyncing`, `jrUnsent`, `jrSchedulePoll`, `jrStaffList`, `jrUpdateStaffFilter`, `jrShift`, `jrIcon`, `jrStub`, `jrShowModal`, `jrNewSession`, `jrSessionPending`, `jrMessage`, `jrWithBusy`, `jrSessionBody`, `jrSave`, строка `jrEl('jrModal').addEventListener('cancel', …)` |
| `journal-grid.js` | `jrCellState`, `jrGridCreate`, `jrLayout`, `jrRender` |
| `journal-card.js` | `jrTools`, `jrClientPanel`, `jrPaymentPanel`, `jrStatusBar`, `jrServicesPanel`, `jrSyncAlert`, `jrLocked`, `jrCanChange`, `jrCanEdit`, `jrAppointmentCard`, `jrOpen`, `jrRenderRecord`, `jrSetCardStatus`, `jrStopRecordWatch`, `jrWatchRecord`, `jrSyncAction`, `jrConfirmAction`, `jrPayFromCard`, `jrBindRecordEdit` |
| `journal-forms.js` | `jrUnsavedKind`, `jrHideCloseAsk`, `jrAskClose`, `jrClose`, `jrCreateClientPanel`, `jrLoadClients`, `jrSelectClient`, `jrServiceMeta`, `jrLineCalculation`, `jrSelectedLines`, `jrLineEditors`, `jrUpdateBill`, `jrCreatePaymentPanel`, `jrServiceCategoryTree`, `jrRenderServiceChoices`, `jrUpdateEndTime`, `jrForm`, `jrFormDraft`, `jrFindSlots`, `jrCreateWithPayment` |
| `journal-payment.js` | `jrKop`, `jrRub`, `jrPaymentView`, `jrPayTitle`, `JR_PAY_STATUS`, `jrPayBadge`, `jrBillItem`, `jrBillSummary`, `jrPaymentBreakdown`, `jrPaymentShow`, `jrPreferredMethod`, `jrRenderPayment`, `jrClearArrivalConfirmation`, `jrAddPayment`, `jrConfirmArrivalPayment`, `jrPayMethod`, `jrRemovePayment`, `jrRestorePayment`, `jrDropPayment`, `jrPayDone`, `jrPayBack`, `jrMergeLivePayment`, `jrOpenPayment` |
| `journal-dispatch.js` | `jrReviewPending`, `jrUpdateDispatchButton`, `jrDispatchWord`, `jrDispatchOpen`, `jrDispatchProgress` |

Готча порядка загрузки: единственная исполняемая при загрузке строка — `jrEl('jrModal').addEventListener('cancel', …)`; ей нужен только `jrEl`, поэтому она остаётся в `journal.js`, который грузится ПЕРВЫМ. Остальные файлы содержат только объявления; ссылки между файлами разрешаются в момент вызова.

- [ ] **Step 1: Перевести тест на загрузку всех файлов и добавить проверки разрезания (тест должен упасть)**

В `backend/journal-ui.test.js` заменить строки 1–18 (от `'use strict';` до конца функции `harness`) на:

```js
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
// All journal files share ONE global scope in the browser (classic <script>s,
// index.html order). The harness runs them the same way, one script each.
const JR_FILES = ['journal.js', 'journal-grid.js', 'journal-card.js', 'journal-forms.js', 'journal-payment.js', 'journal-dispatch.js'];
const readJr = file => fs.readFileSync(path.join(__dirname, '../frontend/js/pages', file), 'utf8');
const JR_SOURCES = JR_FILES.map(file => ({ file, code: readJr(file) }));
const JR_ALL = JR_SOURCES.map(s => s.code).join('\n');
function harness() {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false,
      get options() { return Array.from({ length: (this.innerHTML.match(/<option/g) || []).length }); }, selectedOptions: [],
      addEventListener: jest.fn(), querySelectorAll: () => [], insertAdjacentHTML: jest.fn(), showModal() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(id);
  };
  let uuid = 0;
  const context = vm.createContext({ document: { getElementById: get }, Date, URLSearchParams, AbortController, setTimeout, clearTimeout, encodeURIComponent, crypto: { randomUUID: () => 'synthetic-uuid-' + (++uuid) }, TOKEN: 'synthetic-token', ME: { role: 'owner' }, notify: jest.fn(), fetch: jest.fn(), confirm: jest.fn(() => false) });
  for (const s of JR_SOURCES) vm.runInContext(s.code, context, { filename: s.file });
  return { context, get, run: expression => vm.runInContext(expression, context) };
}
// Top-level names of a classic script: a duplicate const/let across files is a
// SyntaxError that kills the whole page; a duplicate function silently wins.
function jrTopLevelNames(code) {
  const out = [];
  for (const m of code.matchAll(/^(?:async\s+function|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) out.push(m[1]);
  return out;
}
test('journal files: no top-level name is declared twice across files', () => {
  const seen = new Map();
  for (const s of JR_SOURCES) for (const name of jrTopLevelNames(s.code)) {
    expect({ name, file: s.file, other: seen.get(name) || null }).toEqual({ name, file: s.file, other: null });
    seen.set(name, s.file);
  }
  expect(seen.size).toBeGreaterThan(100);
});
test('index.html loads every journal file in order, after the dialog, with a cache buster', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  let last = html.indexOf('id="jrModal"');
  for (const file of JR_FILES) {
    const at = html.search(new RegExp(`src="js/pages/${file.replace('.', '\\.')}\\?v=[^"]+"`));
    expect({ file, found: at > last }).toEqual({ file, found: true });
    last = at;
  }
});
```

Заменить тест `index bumps journal script and stylesheet cache busters` (строки ~279–282) на:

```js
test('index bumps journal stylesheet cache buster',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../frontend/index.html'),'utf8');
 expect(html).toMatch(/css\/journal\.css\?v=[^"]+"/);
});
```

В тесте `visit colours follow the YClients status palette …` (строки ~706–707) заменить

```js
 const js=fs.readFileSync(path.join(__dirname,'../frontend/js/pages/journal.js'),'utf8');
```
на
```js
 const js=JR_ALL;
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest backend/journal-ui --silent`
Expected: FAIL — `ENOENT: no such file or directory, open '…/frontend/js/pages/journal-grid.js'`.

- [ ] **Step 3: Разрезать файл скриптом**

Создать `/tmp/jr-split.js` (вне репозитория) с содержимым:

```js
'use strict';
// One-off: splits frontend/js/pages/journal.js by top-level declarations.
// Every top-level item starts at column 0 with `function`, `async function`,
// `const` or the single `jrEl('jrModal').addEventListener(...)` line. Column-0
// `//` comments belong to the NEXT item; everything else to the current one.
const fs = require('fs');
const path = require('path');
const dir = '/root/loyalpro/frontend/js/pages';
const src = fs.readFileSync(path.join(dir, 'journal.js'), 'utf8');
const MAP = {
  'journal.js': ['journal', 'jrEl', 'jrEscape', 'jrToday', 'JR_PX_PER_MIN', 'jrMinutes', 'jrTimeLabel', 'jrStatus', 'jrApi', 'loadJournal', 'jrClock', 'jrFreshnessText', 'jrSyncing', 'jrUnsent', 'jrSchedulePoll', 'jrStaffList', 'jrUpdateStaffFilter', 'jrShift', 'jrIcon', 'jrStub', 'jrShowModal', 'jrNewSession', 'jrSessionPending', 'jrMessage', 'jrWithBusy', 'jrSessionBody', 'jrSave', '__modalCancel'],
  'journal-grid.js': ['jrCellState', 'jrGridCreate', 'jrLayout', 'jrRender'],
  'journal-card.js': ['jrTools', 'jrClientPanel', 'jrPaymentPanel', 'jrStatusBar', 'jrServicesPanel', 'jrSyncAlert', 'jrLocked', 'jrCanChange', 'jrCanEdit', 'jrAppointmentCard', 'jrOpen', 'jrRenderRecord', 'jrSetCardStatus', 'jrStopRecordWatch', 'jrWatchRecord', 'jrSyncAction', 'jrConfirmAction', 'jrPayFromCard', 'jrBindRecordEdit'],
  'journal-forms.js': ['jrUnsavedKind', 'jrHideCloseAsk', 'jrAskClose', 'jrClose', 'jrCreateClientPanel', 'jrLoadClients', 'jrSelectClient', 'jrServiceMeta', 'jrLineCalculation', 'jrSelectedLines', 'jrLineEditors', 'jrUpdateBill', 'jrCreatePaymentPanel', 'jrServiceCategoryTree', 'jrRenderServiceChoices', 'jrUpdateEndTime', 'jrForm', 'jrFormDraft', 'jrFindSlots', 'jrCreateWithPayment'],
  'journal-payment.js': ['jrKop', 'jrRub', 'jrPaymentView', 'jrPayTitle', 'JR_PAY_STATUS', 'jrPayBadge', 'jrBillItem', 'jrBillSummary', 'jrPaymentBreakdown', 'jrPaymentShow', 'jrPreferredMethod', 'jrRenderPayment', 'jrClearArrivalConfirmation', 'jrAddPayment', 'jrConfirmArrivalPayment', 'jrPayMethod', 'jrRemovePayment', 'jrRestorePayment', 'jrDropPayment', 'jrPayDone', 'jrPayBack', 'jrMergeLivePayment', 'jrOpenPayment'],
  'journal-dispatch.js': ['jrReviewPending', 'jrUpdateDispatchButton', 'jrDispatchWord', 'jrDispatchOpen', 'jrDispatchProgress'],
};
const HEAD = {
  'journal-grid.js': '// Журнал записи: сетка дня и недели. Общая глобальная область с journal.js (префикс jr).',
  'journal-card.js': '// Журнал записи: карточка записи. Общая глобальная область с journal.js (префикс jr).',
  'journal-forms.js': '// Журнал записи: формы создания/переноса, поиск клиента, вопрос при закрытии. Общая глобальная область с journal.js.',
  'journal-payment.js': '// Журнал записи: форма оплаты визита. Общая глобальная область с journal.js (префикс jr).',
  'journal-dispatch.js': '// Журнал записи: «Отправить в YClients» и сверка операций. Общая глобальная область с journal.js.',
};
const owner = new Map();
for (const [file, names] of Object.entries(MAP)) for (const n of names) {
  if (owner.has(n)) throw new Error('name mapped twice: ' + n);
  owner.set(n, file);
}
const START = /^(?:async\s+function|function|const)\s+([A-Za-z_$][\w$]*)|^(jrEl\('jrModal'\)\.addEventListener)/;
const lines = src.split('\n');
const items = [];
let pending = [];
let cur = null;
for (const line of lines) {
  const m = START.exec(line);
  if (m) { cur = { name: m[1] || '__modalCancel', lines: [...pending, line] }; pending = []; items.push(cur); continue; }
  if (/^\/\//.test(line)) { pending.push(line); continue; }
  if (!cur) { pending.push(line); continue; }
  cur.lines.push(line);
}
if (pending.some(l => l.trim())) throw new Error('trailing comment without item: ' + pending.join(' | '));
const out = Object.fromEntries(Object.keys(MAP).map(f => [f, []]));
for (const item of items) {
  const file = owner.get(item.name);
  if (!file) throw new Error('unmapped top-level item: ' + item.name);
  out[file].push(...item.lines);
}
const seen = new Set(items.map(i => i.name));
for (const n of owner.keys()) if (!seen.has(n)) throw new Error('mapped name not found in journal.js: ' + n);
const total = Object.values(out).reduce((n, l) => n + l.length, 0) + pending.length;
if (total !== lines.length) throw new Error(`line count mismatch ${total} != ${lines.length}`);
for (const [file, body] of Object.entries(out)) {
  const text = (HEAD[file] ? HEAD[file] + '\n' : '') + body.join('\n').replace(/\n+$/, '') + '\n';
  fs.writeFileSync(path.join(dir, file), text);
  console.log(file, body.length, 'lines');
}
```

Run: `export PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH && node /tmp/jr-split.js`
Expected: шесть строк вида `journal.js 3xx lines` … без исключений. Затем проверить синтаксис каждого файла:

Run: `cd /root/loyalpro/frontend/js/pages && for f in journal.js journal-grid.js journal-card.js journal-forms.js journal-payment.js journal-dispatch.js; do node --check $f || echo FAIL $f; done`
Expected: пусто (ни одной строки `FAIL`).

- [ ] **Step 4: Подключить файлы в `frontend/index.html`**

Строку (сейчас ~3047)
```html
<script src="js/pages/journal.js?v=bill2-2026-11-12"></script>
```
заменить на
```html
<script src="js/pages/journal.js?v=split-2026-11-12"></script>
<script src="js/pages/journal-grid.js?v=split-2026-11-12"></script>
<script src="js/pages/journal-card.js?v=split-2026-11-12"></script>
<script src="js/pages/journal-forms.js?v=split-2026-11-12"></script>
<script src="js/pages/journal-payment.js?v=split-2026-11-12"></script>
<script src="js/pages/journal-dispatch.js?v=split-2026-11-12"></script>
```

- [ ] **Step 5: Запустить тесты — все зелёные**

Run: `cd /root/loyalpro/backend && npx jest backend/journal-ui --silent`
Expected: PASS, 76 тестов (74 прежних + 2 новых; тест про cache buster переписан, а не добавлен).
Run: `npx jest backend/journal service-catalog finance bonus-ledger --silent`
Expected: `Test Suites: 26 passed`, тестов ≥ 554.

- [ ] **Step 6: Ручная проверка, что страница жива**

Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 3 && curl -s http://127.0.0.1:3001/ | grep -c 'js/pages/journal'`
Expected: `6`.

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro && git add frontend/js/pages/journal.js frontend/js/pages/journal-grid.js frontend/js/pages/journal-card.js frontend/js/pages/journal-forms.js frontend/js/pages/journal-payment.js frontend/js/pages/journal-dispatch.js frontend/index.html backend/journal-ui.test.js && git commit -m "refactor(journal): journal.js разрезан на шесть файлов одной глобальной области

Без изменения поведения. journal-ui.test.js грузит все файлы одним vm и
проверяет, что верхнеуровневые имена не повторяются между файлами.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 2: Сервер — новые поля записи, справочник меток, телефон в карточке

**Исполнитель:** Sonnet. **Зависимости:** нет.

**Files:**
- Modify: `backend/services/journal/model.js` (функции `normalizeRecord` ~стр. 61–76, `slotsFor` ~стр. 152–182, `module.exports`)
- Modify: `backend/services/journal/reference-cache.js:7-13` (`KINDS`, `PATHS`)
- Modify: `backend/services/journal/sources.js` (`live`, `local`)
- Modify: `backend/services/journal/index.js` (`day`, `detail`)
- Test: `backend/journal-model.test.js`, `backend/journal-reference-cache.test.js`, `backend/journal-service.test.js`

Контракт полей нормализованной записи (используют задачи 9–13):
- `online` (boolean), `isNew` (boolean, из `client.is_new`), `comment` (строка), `customColor` (`'#rrggbb'` или `null`), `fontColor` (`'#rrggbb'` или `null`), `labels` (`[{id, title, color}]`, `color` — `'#rrggbb'` или `''`; метка, пришедшая числом, даёт `{id, title:'', color:''}` — фронт достаёт название из `journal.data.labels`), `technicalBreak` (секунды, ≥0), `visitCounts` (`{success, fail}`, каждое число или `null`), `clientPhone` — ТОЛЬКО при `normalizeRecord(r, { withPhone: true })`.
- `normColor(v)` принимает `'F4A0A0'`, `'#f4a0a0'`, `' #F4A0A0 '` → `'#f4a0a0'`; иначе `null`. Формат `custom_color` в ответах YClients не подтверждён (данных на деве нет) — поэтому принимаем оба вида.

- [ ] **Step 1: Падающие тесты модели**

В конец `backend/journal-model.test.js` добавить:

```js
describe('normalizeRecord: parity fields (12.11.2026)', () => {
  const full = { ...record, online: true, comment: 'Позвонить', custom_color: 'F4A0A0', custom_font_color: '#FFFFFF',
    record_labels: [{ id: 3, title: 'VIP', color: '#FF0000', entity: 1 }, 4], technical_break_duration: 900,
    client: { name: 'Тест', phone: '+79200255591', is_new: 1, success_visits_count: 5, fail_visits_count: 1 } };
  test('maps online, new client, comment, colours, labels, break and visit counts', () => {
    expect(m.normalizeRecord(full)).toMatchObject({
      online: true, isNew: true, comment: 'Позвонить', customColor: '#f4a0a0', fontColor: '#ffffff',
      labels: [{ id: 3, title: 'VIP', color: '#ff0000' }, { id: 4, title: '', color: '' }],
      technicalBreak: 900, visitCounts: { success: 5, fail: 1 },
    });
  });
  test('phone only on explicit request (card), never in the day grid', () => {
    expect(m.normalizeRecord(full)).not.toHaveProperty('clientPhone');
    expect(m.normalizeRecord(full, { withPhone: true }).clientPhone).toBe('+79200255591');
  });
  test('garbage values are neutralised', () => {
    const out = m.normalizeRecord({ ...record, online: 0, custom_color: 'red', technical_break_duration: -5, record_labels: [{ id: 'x' }, 0, null] });
    expect(out).toMatchObject({ online: false, isNew: false, customColor: null, fontColor: null, technicalBreak: 0, labels: [], visitCounts: { success: null, fail: null } });
  });
  test('normColor and normalizeLabels are exported', () => {
    expect(m.normColor(' #ABCDEF ')).toBe('#abcdef');
    expect(m.normColor('#abc')).toBe(null);
    expect(m.normalizeLabels([{ id: 2, title: 'Новый', color: '00ff00' }])).toEqual([{ id: 2, title: 'Новый', color: '#00ff00' }]);
  });
});
test('technical break of an existing visit occupies the time after it', () => {
  const slots = m.slotsFor({ ...context, duration: 30, records: [{ ...record, technical_break_duration: 1800 }] });
  expect(slots).not.toContain('11:00');
  expect(slots).toContain('11:30');
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/backend && npx jest backend/journal-model --silent`
Expected: FAIL — `expect(received).toMatchObject` (нет `online`), `m.normColor is not a function`, слот `11:00` доступен.

- [ ] **Step 3: Реализация в `model.js`**

Перед `function normalizeRecord(r) {` вставить:

```js
// YClients colour: «F4A0A0» or «#f4a0a0» — the format of custom_color in
// upstream answers is not confirmed on dev data, both are accepted.
function normColor(v) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(v ?? '').trim());
  return m ? '#' + m[1].toLowerCase() : null;
}
// record_labels arrive as objects in GET /record, as plain ids in our own
// overlay (we send ids in PUT). A plain id has no title: the UI resolves it
// from the salon's label list (GET /day → labels).
function normalizeLabels(list) {
  return (Array.isArray(list) ? list : []).map(l => (l && typeof l === 'object')
    ? { id: Number(l.id), title: String(l.title || ''), color: normColor(l.color) || '' }
    : { id: Number(l), title: '', color: '' })
    .filter(l => Number.isSafeInteger(l.id) && l.id > 0);
}
const countOf = v => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const truthy = v => v === true || v === 1 || v === '1';
```

Заменить функцию `normalizeRecord` целиком на:

```js
function normalizeRecord(r, opts = {}) {
  const at = moscowParts(r.datetime || r.date);
  return {
    id: Number(r.id), staffId: Number(r.staff_id || r.staff?.id),
    staffName: String(r.staff?.name || 'Сотрудник'), date: at?.date, time: at?.time,
    duration: Number(r.seance_length) / 60 || 0,
    clientName: String(r.client?.name || 'Без имени'),
    services: (Array.isArray(r.services) ? r.services : []).map(s => ({ id: Number(s.id), title: String(s.title || ''), cost: Number(s.cost) || 0, quantity: Number(s.amount) || 1, unitPrice: Number(s.cost_per_unit ?? (Number(s.first_cost ?? s.cost) / (Number(s.amount) || 1))) || 0 })),
    attendance: Number(r.attendance) || 0, deleted: !!r.deleted,
    paid: !!r.paid_full || Number(r.paid_amount) > 0,
    // YClients colours a came visit orange only when it is paid in full (paid_full=1), yellow otherwise.
    paidFull: Number(r.paid_full) === 1,
    // Parity fields (12.11.2026).
    online: truthy(r.online), isNew: truthy(r.client?.is_new),
    comment: String(r.comment || ''),
    customColor: normColor(r.custom_color), fontColor: normColor(r.custom_font_color),
    labels: normalizeLabels(r.record_labels),
    technicalBreak: Math.max(0, Number(r.technical_break_duration) || 0),
    visitCounts: { success: countOf(r.client?.success_visits_count), fail: countOf(r.client?.fail_visits_count) },
    // The phone is for the card only (owner/admin router); the day grid never carries it.
    ...(opts.withPhone ? { clientPhone: String(r.client?.phone || '') } : {}),
    version: revision(r), editVersion: editRevision(r), servicesVersion: servicesRevision(r),
    sync: r._sync || null,
  };
}
```

В `slotsFor` заменить строку
```js
    return { r, start: (at.ms - dayStart) / 60000, end: (at.ms - dayStart) / 60000 + length };
```
на
```js
    // A technical break after the visit is occupied time too (12.11.2026).
    const pause = Math.max(0, Number(r.technical_break_duration) || 0) / 60;
    return { r, start: (at.ms - dayStart) / 60000, end: (at.ms - dayStart) / 60000 + length + pause };
```

В `module.exports` добавить `normColor, normalizeLabels` (через запятую в существующий объект).

- [ ] **Step 4: Тесты модели зелёные**

Run: `npx jest backend/journal-model --silent`
Expected: PASS.

- [ ] **Step 5: Падающие тесты справочника меток и карточки**

В `backend/journal-reference-cache.test.js`, тест `writes 4 kinds; failure of one does not stop others`, заменить ожидания:

```js
    expect(yc.list.mock.calls.map(c => c[1])).toEqual(['/staff/77', '/company/77/services/', '/resources/77', '/accounts/77', '/labels/77']);
    expect(r).toEqual({ ok: ['staff', 'services', 'accounts', 'labels'], failed: ['resources'] });
    const kinds = db.query.mock.calls.map(c => c[1][1]);
    expect(kinds).toEqual(['staff', 'services', 'accounts', 'labels']);
```
(название теста поменять на `writes 5 kinds; failure of one does not stop others`).

В конец `backend/journal-service.test.js` добавить:

```js
describe('parity fields (12.11.2026)', () => {
  test('day carries the salon label list, normalised', async () => {
    const base = yc.list.getMockImplementation();
    yc.list.mockImplementation(async (s, path) => path === '/labels/30' ? [{ id: 3, title: 'VIP', color: 'FF0000' }] : base(s, path));
    const out = await service.day(3, '2030-04-01');
    expect(out.labels).toEqual([{ id: 3, title: 'VIP', color: '#ff0000' }]);
  });
  test('day survives a labels failure with an empty list', async () => {
    const base = yc.list.getMockImplementation();
    yc.list.mockImplementation(async (s, path) => { if (path === '/labels/30') throw new Error('boom'); return base(s, path); });
    expect((await service.day(3, '2030-04-01')).labels).toEqual([]);
  });
  test('card (detail) carries the client phone', async () => {
    yc.getRecord.mockResolvedValue({ ...structuredClone(record), client: { id: 5, name: 'Тест', phone: '79200255591' } });
    expect((await service.detail(3, 8)).clientPhone).toBe('79200255591');
  });
});
```

- [ ] **Step 6: Запустить — падают**

Run: `npx jest backend/journal-reference-cache backend/journal-service --silent`
Expected: FAIL — нет `/labels/77`, `out.labels` = `undefined`, `clientPhone` = `undefined`.

- [ ] **Step 7: Реализация**

`reference-cache.js`: заменить

```js
const KINDS = ['staff', 'services', 'resources', 'accounts'];
const PATHS = {
  staff: cid => `/staff/${cid}`,
  services: cid => `/company/${cid}/services/`,
  resources: cid => `/resources/${cid}`,
  accounts: cid => `/accounts/${cid}`,
};
```
на
```js
const KINDS = ['staff', 'services', 'resources', 'accounts', 'labels'];
const PATHS = {
  staff: cid => `/staff/${cid}`,
  services: cid => `/company/${cid}/services/`,
  resources: cid => `/resources/${cid}`,
  accounts: cid => `/accounts/${cid}`,
  // Record labels (colour + title) of the salon; refreshed with the rest every 30 min.
  labels: cid => `/labels/${cid}`,
};
```

`sources.js`: в объект, возвращаемый `live(salon)`, после строки `accounts: () => yc.list(salon, \`/accounts/${cid}\`),` добавить
```js
    labels: () => yc.list(salon, `/labels/${cid}`),
```
в объект `local(salon)` после `staff: ref('staff'), services: ref('services'), resources: ref('resources'), accounts: ref('accounts'),` добавить
```js
    // Labels are decoration: a cold cache is an empty list, not an error.
    labels: async () => (await reference.getReference(salon.id, 'labels')) || [],
```

`index.js`, функция `day`: заменить строку
```js
  const [staffSource, local, records] = await Promise.all([src.staff(), localCatalog.forJournal(salonId), src.records(shiftDate(date, -1), shiftDate(date, 1))]);
```
на
```js
  const [staffSource, local, records, labels] = await Promise.all([src.staff(), localCatalog.forJournal(salonId),
    src.records(shiftDate(date, -1), shiftDate(date, 1)),
    typeof src.labels === 'function' ? src.labels().catch(() => []) : []]);
```
и в возвращаемый объект после `services: local.services, categories: local.categories, serviceSource: 'internal',` добавить строку
```js
    labels: m.normalizeLabels(labels),
```

`index.js`, функция `detail`: во ВСЕХ трёх местах заменить `m.normalizeRecord(r)` на `m.normalizeRecord(r, { withPhone: true })` (найти: `grep -n "normalizeRecord(r)" backend/services/journal/index.js` — три строки).

- [ ] **Step 8: Тесты зелёные + базовая линия**

Run: `npx jest backend/journal-reference-cache backend/journal-service backend/journal-model --silent`
Expected: PASS.
Run: `npx jest backend/journal service-catalog finance bonus-ledger --silent`
Expected: 26 наборов зелёные.

- [ ] **Step 9: Commit**

```bash
cd /root/loyalpro && git add backend/services/journal/model.js backend/services/journal/reference-cache.js backend/services/journal/sources.js backend/services/journal/index.js backend/journal-model.test.js backend/journal-reference-cache.test.js backend/journal-service.test.js && git commit -m "feat(journal): цвет, метки, онлайн, новый клиент, технический перерыв в записи; метки салона и телефон в карточке

normalizeRecord отдаёт поля паритета с YClients; телефон — только карточке
(withPhone). Технический перерыв занимает время в расчёте слотов.
Справочник меток кэшируется вместе с остальными, GET /day отдаёт labels.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 3: Сервер — новые поля правки записи (`edit`) и `create.notifyClient`

**Исполнитель:** Opus (связное ядро: проверка окна, тело PUT, наложение). **Зависимости:** T2.

Задача разбита на три коммита. Имена, на которые опираются следующие задачи:
- поля `edit` в теле сессии и в `steps[edit].params`: `comment`, `seanceLength` (мин), `client {name, phone}`, `customColor` (`'#rrggbb'`|`null`), `labelIds` (`number[]`), `technicalBreak` (сек), `notifyClient` (boolean);
- поля наложения (`overlay.patch`): `comment`, `seance_length`, `client`, `custom_color`, `record_labels` (ids), `technical_break_duration`, `notify_client` (последнее — только для показа, в YClients не уходит);
- `index.availability(salon, draft, record, src)` понимает `draft.durationOverride` (мин) и `draft.technicalBreak` (сек);
- `model.slotsFor({ …, breakMinutes })`;
- `model.recordExtras(record)` → `{custom_color?, record_labels?, technical_break_duration?}`;
- `create.notifyClient` (boolean) после `parseDraft`.

#### Task 3a: Окно с явной длительностью и техническим перерывом

**Files:**
- Modify: `backend/services/journal/model.js` (`slotsFor`)
- Modify: `backend/services/journal/index.js` (`availability`, строки ~107–135)
- Test: `backend/journal-model.test.js`, `backend/journal-service.test.js`

- [ ] **Step 1: Падающие тесты**

В конец `backend/journal-model.test.js`:

```js
test('candidate technical break must fit the shift and must not overlap', () => {
  const slots = m.slotsFor({ ...context, duration: 30, breakMinutes: 30, records: [] });
  expect(slots).toContain('11:00');      // 11:00 + 30 + 30 = 12:00 — край смены
  expect(slots).not.toContain('11:05');
  const busy = m.slotsFor({ ...context, duration: 30, breakMinutes: 30, records: [{ ...record, datetime: '2030-04-01T10:00:00+03:00' }] });
  expect(busy).not.toContain('09:05');   // 09:05 + 60 заходит на визит 10:00
  expect(busy).toContain('09:00');
});
```

В блок `describe('parity fields (12.11.2026)', …)` файла `backend/journal-service.test.js` добавить:

```js
  test('availability: explicit duration and the record technical break', async () => {
    const salon = { id: 3, yclients_company_id: 30 };
    const src = require('./services/journal/sources').live(salon);
    const out = await service.availability(salon, { staffId: 1, date: '2030-04-01', time: '09:00', durationOverride: 90, technicalBreak: 1800 }, record, src);
    expect(out.duration).toBe(90);
    expect(out.slots).toContain('09:00');
    expect(out.slots).toContain('10:00');     // 10:00 + 90 + 30 = 12:00
    expect(out.slots).not.toContain('10:05');
    const plain = await service.availability(salon, { staffId: 1, date: '2030-04-01', time: '09:00' }, { ...record, technical_break_duration: 600 }, src);
    expect(plain.duration).toBe(60);
    expect(plain.slots).toContain('10:50');   // 60 + 10
    expect(plain.slots).not.toContain('10:55');
  });
```

- [ ] **Step 2: Запустить — падают**

Run: `cd /root/loyalpro/backend && npx jest backend/journal-model backend/journal-service --silent`
Expected: FAIL — `11:05` есть в слотах (перерыв кандидата не учитывается), `out.duration` = 60.

- [ ] **Step 3: Реализация**

`model.js`, `slotsFor`: сигнатуру
```js
function slotsFor({ date, staffId, duration, schedule, records, resourceIds, resources, excludeId, now = Date.now() }) {
```
заменить на
```js
function slotsFor({ date, staffId, duration, breakMinutes = 0, schedule, records, resourceIds, resources, excludeId, now = Date.now() }) {
  // The visit's own technical break (12.11.2026) is occupied time after it.
  const span = duration + Math.max(0, Number(breakMinutes) || 0);
```
и в цикле заменить
```js
  for (const range of free) for (let t = Math.ceil(range.start / 5) * 5; t + duration <= range.end && t + duration <= 1440; t += 5) {
```
на
```js
  for (const range of free) for (let t = Math.ceil(range.start / 5) * 5; t + span <= range.end && t + span <= 1440; t += 5) {
```
и строку
```js
    for (const w of windows) if (t < w.end && t + duration > w.start) {
```
на
```js
    for (const w of windows) if (t < w.end && t + span > w.start) {
```

`index.js`, `availability`: строку, начинающуюся с `  const duration = record ? Number(record.seance_length) / 60 : local ?`, переименовать в `  const computed = record ? …` (выражение справа не меняется), а сразу после неё (после её завершающего `}, 0);`) вставить:

```js
  // An explicit length from the card / resize handle (12.11.2026) wins.
  const override = Number(draft.durationOverride);
  const duration = Number.isInteger(override) && override > 0 ? override : computed;
  // Technical break: the edited value, else the record's own, else none.
  const pauseSec = draft.technicalBreak !== undefined ? Number(draft.technicalBreak)
    : record ? Number(record.technical_break_duration) || 0 : 0;
  const breakMinutes = Math.max(0, pauseSec) / 60;
```

В последней строке `availability` (`return { duration, … slots: m.slotsFor({ ...draft, duration, schedule, …`) заменить `m.slotsFor({ ...draft, duration, schedule,` на `m.slotsFor({ ...draft, duration, breakMinutes, schedule,`.

- [ ] **Step 4: Зелёные**

Run: `npx jest backend/journal-model backend/journal-service --silent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/journal/model.js backend/services/journal/index.js backend/journal-model.test.js backend/journal-service.test.js && git commit -m "feat(journal): проверка окна с явной длительностью и техническим перерывом

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

#### Task 3b: `record-edit` принимает новые поля; PUT сохраняет цвет/метки/перерыв

**Files:**
- Modify: `backend/services/journal/record-edit.js` (функции `parse`, `patch` целиком)
- Modify: `backend/services/journal/model.js` (`recordExtras`, `parseDraft` — ветка create)
- Modify: `backend/services/journal/index.js` (`prepare`)
- Test: `backend/journal-record-edit.test.js`, `backend/journal-model.test.js`, `backend/journal-service.test.js`

Готча: YClients `PUT /record` ждёт запись ЦЕЛИКОМ («наш опыт: нужен полный набор полей»). Сегодня `prepare` не передаёт `custom_color`/`record_labels`/`technical_break_duration`, значит любой перенос или смена статуса МОЖЕТ стереть цвет и метки, поставленные в YClients. Поэтому все PUT-тела получают `...m.recordExtras(record)`; проверка — в живом прогоне (задача 14, §«Живой прогон»).

- [ ] **Step 1: Падающие тесты**

В конец `backend/journal-record-edit.test.js`:

```js
describe('parity fields (12.11.2026)', () => {
  const labelsSrc = { ...src, labels: async () => [{ id: 3, title: 'VIP' }, { id: 4, title: 'Важно' }] };
  test('parse validates every new field', () => {
    expect(parse({ comment: '  Позвонить  ', seanceLength: 75, client: { name: ' Анна ', phone: '8 (920) 025-55-91' }, customColor: '#F4A0A0',
      labelIds: [3, '4', 3], technicalBreak: 600, notifyClient: false })).toEqual({ comment: 'Позвонить', seanceLength: 75,
      client: { name: 'Анна', phone: '79200255591' }, customColor: '#f4a0a0', labelIds: [3, 4], technicalBreak: 600, notifyClient: false });
    expect(parse({ customColor: null })).toEqual({ customColor: null });
    for (const bad of [{ seanceLength: 7 }, { seanceLength: 0 }, { seanceLength: 725 }, { technicalBreak: 100 }, { technicalBreak: 3900 },
      { customColor: 'red' }, { client: { name: 'A', phone: '123' } }, { client: { name: '', phone: '79200255591' } },
      { comment: 'x'.repeat(1001) }, { labelIds: [0] }, { notifyClient: 'no' }, { servicesVersion: 'a'.repeat(64) }]) {
      expect(() => parse(bad)).toThrow();
    }
  });
  test('patch builds the YClients fields; notifyClient never reaches YClients', async () => {
    const out = await patch({ id: 3 }, { ...record, datetime: '2020-01-01T10:00:00+03:00' }, { comment: 'Позвонить', customColor: null, labelIds: [4], technicalBreak: 0,
      client: { name: 'Анна', phone: '79200255591' }, notifyClient: false }, labelsSrc, jest.fn());
    expect(out).toEqual({ comment: 'Позвонить', custom_color: '', record_labels: [4], technical_break_duration: 0, client: { phone: '79200255591', name: 'Анна' } });
  });
  test('comment, colour and labels are allowed for an arrived visit; duration and client are not', async () => {
    const arrived = { ...record, attendance: 1 };
    await expect(patch({}, arrived, { comment: 'ok' }, src, jest.fn())).resolves.toEqual({ comment: 'ok' });
    await expect(patch({}, arrived, { seanceLength: 90 }, src, jest.fn())).rejects.toMatchObject({ status: 409 });
    await expect(patch({}, record, { client: { name: 'A', phone: '79200255591' }, attendance: 1 }, src, jest.fn())).rejects.toMatchObject({ status: 409 });
  });
  test('unknown label or cold label cache is refused', async () => {
    await expect(patch({}, record, { labelIds: [9] }, labelsSrc, jest.fn())).rejects.toThrow('Метка не найдена');
    await expect(patch({}, record, { labelIds: [3] }, src, jest.fn())).rejects.toMatchObject({ status: 503 });
    await expect(patch({}, record, { labelIds: [] }, src, jest.fn())).resolves.toEqual({ record_labels: [] });
  });
  test('a longer visit or a break re-checks the window with the explicit length; a started visit does not', async () => {
    const availability = jest.fn(async () => ({ slots: ['10:00'] }));
    const out = await patch({ id: 3 }, record, { seanceLength: 90, technicalBreak: 300 }, src, availability);
    expect(out).toEqual({ seance_length: 5400, technical_break_duration: 300 });
    expect(availability.mock.calls[0][1]).toEqual({ staffId: 5, date: '2030-04-01', time: '10:00', durationOverride: 90, technicalBreak: 300 });
    expect(availability.mock.calls[0][2]).toMatchObject({ id: 1 });
    await expect(patch({}, record, { seanceLength: 90 }, src, async () => ({ slots: [] }))).rejects.toMatchObject({ code: 'slot_taken' });
    const started = { ...record, datetime: '2020-01-01T10:00:00+03:00' };
    const none = jest.fn();
    await patch({}, started, { seanceLength: 90 }, src, none);
    expect(none).not.toHaveBeenCalled();
  });
});
```

В конец `backend/journal-model.test.js`:

```js
test('create accepts notifyClient boolean only', () => {
  expect(m.parseDraft({ ...base, notifyClient: false }, 'create').notifyClient).toBe(false);
  expect(m.parseDraft(base, 'create')).not.toHaveProperty('notifyClient');
  expect(() => m.parseDraft({ ...base, notifyClient: 'no' }, 'create')).toThrow();
});
test('recordExtras carries colour, label ids and break back into a full PUT', () => {
  expect(m.recordExtras({ custom_color: 'f4a0a0', record_labels: [{ id: 3, title: 'VIP' }, 4], technical_break_duration: 600 }))
    .toEqual({ custom_color: 'f4a0a0', record_labels: [3, 4], technical_break_duration: 600 });
  expect(m.recordExtras({})).toEqual({});
});
```

В блок `describe('parity fields (12.11.2026)', …)` файла `backend/journal-service.test.js`:

```js
  test('edit sends the new comment and keeps colour, labels and break of the record', async () => {
    const rec = { ...record, custom_color: '#f4a0a0', record_labels: [{ id: 3, title: 'VIP' }], technical_break_duration: 600 };
    yc.getRecord.mockResolvedValue(structuredClone(rec));
    await service.mutate(3, 4, { operationId, action: 'edit', recordId: 8, version: m.revision(rec), edit: { comment: 'Новый' } });
    expect(yc.write.mock.calls[0][2]).toMatchObject({ comment: 'Новый', custom_color: '#f4a0a0', record_labels: [3], technical_break_duration: 600 });
  });
  test('move and confirm keep colour and labels', async () => {
    const rec = { ...record, custom_color: '#f4a0a0', record_labels: [{ id: 3 }] };
    yc.getRecord.mockResolvedValue(structuredClone(rec));
    await service.mutate(3, 4, { operationId, action: 'move', recordId: 8, version: m.revision(rec), date: '2030-04-01', time: '11:00', staffId: 1 });
    await service.mutate(3, 4, { operationId: '22345678-1234-4123-8123-123456789012', action: 'confirm', recordId: 8, version: m.revision(rec) });
    expect(yc.write.mock.calls[0][2]).toMatchObject({ custom_color: '#f4a0a0', record_labels: [3] });
    expect(yc.write.mock.calls[1][2]).toMatchObject({ custom_color: '#f4a0a0', record_labels: [3], attendance: 2 });
  });
```

- [ ] **Step 2: Запустить — падают**

Run: `npx jest backend/journal-record-edit backend/journal-model backend/journal-service --silent`
Expected: FAIL — `parse` бросает «Нет изменений для сохранения» на новых полях; `m.recordExtras is not a function`; `custom_color` нет в теле PUT.

- [ ] **Step 3: Реализация `record-edit.js`**

Заменить функцию `parse` целиком на:

```js
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_LABELS = 20;
// One card edit (12.11.2026: comment, duration, client, colour, labels,
// technical break and «не уведомлять» next to status and services).
function parse(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) m.fail('Некорректные изменения записи.');
  const out = {};
  // `version` (whole-record) is still accepted from older clients but no
  // longer decides anything: it made every edit after the user's own status
  // or payment package fail as «stale» (10.11.2026, outbox 16).
  if (input.version !== undefined && !/^[a-f0-9]{64}$/.test(input.version)) m.fail('Некорректная версия записи.');
  if (input.servicesVersion !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(input.servicesVersion)) m.fail('Некорректная версия записи.');
    out.servicesVersion = input.servicesVersion;
  }
  if (input.attendance !== undefined) {
    if (!Number.isInteger(input.attendance) || ![-1, 0, 1, 2].includes(input.attendance)) m.fail('Неизвестный статус записи.');
    out.attendance = input.attendance;
  }
  if (input.lines !== undefined) {
    try { out.lines = pricing.quote(input.lines, input.lines.map(l => Number(l.serviceId))).lines; }
    catch (_) { m.fail('Проверьте услуги, количество, цену и скидку.'); }
  }
  if (input.comment !== undefined) {
    if (typeof input.comment !== 'string') m.fail('Некорректный комментарий.');
    const comment = input.comment.trim();
    if (comment.length > 1000) m.fail('Комментарий слишком длинный.');
    out.comment = comment;
  }
  if (input.seanceLength !== undefined) {
    const n = input.seanceLength;
    if (!Number.isInteger(n) || n < 5 || n > 720 || n % 5 !== 0) m.fail('Длительность — от 5 до 720 минут, кратно 5.');
    out.seanceLength = n;
  }
  if (input.client !== undefined) {
    const c = input.client;
    if (!c || typeof c !== 'object' || Array.isArray(c)) m.fail('Некорректный клиент.');
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name || name.length > 120) m.fail('Укажите имя клиента (до 120 символов).');
    let phone = String(c.phone || '').replace(/[\s()+-]/g, '');
    if (!/^\d{11,15}$/.test(phone)) m.fail('Укажите телефон с кодом страны.');
    if (phone.length === 11 && phone[0] === '8') phone = '7' + phone.slice(1);
    out.client = { name, phone };
  }
  if (input.customColor !== undefined) {
    if (input.customColor === null || input.customColor === '') out.customColor = null;
    else if (typeof input.customColor === 'string' && HEX.test(input.customColor)) out.customColor = input.customColor.toLowerCase();
    else m.fail('Некорректный цвет записи.');
  }
  if (input.labelIds !== undefined) {
    if (!Array.isArray(input.labelIds) || input.labelIds.length > MAX_LABELS) m.fail('Некорректный список меток.');
    out.labelIds = [...new Set(input.labelIds.map(m.positiveId))];
  }
  if (input.technicalBreak !== undefined) {
    const n = input.technicalBreak;
    if (!Number.isInteger(n) || n < 0 || n > 3600 || n % 300 !== 0) m.fail('Технический перерыв — от 0 до 60 минут, кратно 5.');
    out.technicalBreak = n;
  }
  if (input.notifyClient !== undefined) {
    if (typeof input.notifyClient !== 'boolean') m.fail('Некорректный флаг уведомления.');
    out.notifyClient = input.notifyClient;
  }
  if (!Object.keys(out).some(k => k !== 'servicesVersion')) m.fail('Нет изменений для сохранения.');
  return out;
}
```

Заменить функцию `patch` целиком на:

```js
async function patch(salon, record, input, src, availability, paid = false) {
  const edit = parse(input);
  if (edit.lines && edit.servicesVersion && edit.servicesVersion !== m.servicesRevision(record)) m.fail('Услуги визита изменились. Откройте карточку заново.', 409, 'edit_conflict');
  if (record.deleted) m.fail('Запись удалена.', 409);
  if (paid || record.paid_full || Number(record.paid_amount) > 0) m.fail('У визита есть проведённые оплаты. Измените его в YClients.', 409);
  // Spec §4.1: duration and client of a visit that came stay as they are.
  if ((edit.seanceLength !== undefined || edit.client) && (Number(record.attendance) === 1 || edit.attendance === 1)) {
    m.fail('Длительность и клиента пришедшего визита меняйте в YClients.', 409);
  }
  const out = {};
  if (edit.attendance !== undefined) out.attendance = edit.attendance;
  if (edit.comment !== undefined) out.comment = edit.comment;
  // YClients re-links the visit to the card found by this phone.
  if (edit.client) out.client = { phone: edit.client.phone, name: edit.client.name };
  if (edit.customColor !== undefined) out.custom_color = edit.customColor || '';
  if (edit.labelIds !== undefined) {
    if (edit.labelIds.length) {
      const known = typeof src.labels === 'function' ? await src.labels() : null;
      if (!Array.isArray(known) || !known.length) m.fail('Справочник меток ещё не загружен. Повторите позже.', 503, 'cache_cold');
      const ids = new Set(m.normalizeLabels(known).map(l => l.id));
      if (edit.labelIds.some(id => !ids.has(id))) m.fail('Метка не найдена. Обновите журнал.', 409);
    }
    out.record_labels = edit.labelIds;
  }
  if (edit.technicalBreak !== undefined) out.technical_break_duration = edit.technicalBreak;
  if (edit.seanceLength !== undefined) out.seance_length = edit.seanceLength * 60;
  let compositionChanged = false;
  if (edit.lines) {
    const existing = record.services || [];
    const all = await src.services();
    out.services = edit.lines.map(l => {
      const old = existing.find(s => Number(s.id) === l.serviceId);
      const service = all.find(s => Number(s.id) === l.serviceId);
      if (!old && (!service || service.deleted || service.archive || service.is_deleted || !service.staff?.some(s => Number(s.id || s) === Number(record.staff_id)))) m.fail('Услуга недоступна у сотрудника.', 409);
      // cost_to_pay/manual_cost describe the OLD price; carried over they would
      // contradict the new cost (YClients recalculates them from cost).
      const { cost_to_pay, manual_cost, ...kept } = old || {};
      return { ...kept, id: l.serviceId, title: String(old?.title || service?.title || ''), amount: l.quantity,
        cost_per_unit: l.unitPrice, first_cost: l.gross, discount: l.discount, cost: l.total };
    });
    // Quantity/price changes cannot collide; only a different SET of services
    // (equipment) can.
    const ids = list => [...new Set(list.map(s => Number(s.id)))].sort((a, b) => a - b).join(',');
    compositionChanged = ids(out.services) !== ids(existing);
  }
  const lengthChanged = (edit.seanceLength !== undefined && edit.seanceLength * 60 !== Number(record.seance_length))
    || (edit.technicalBreak !== undefined && edit.technicalBreak !== (Number(record.technical_break_duration) || 0));
  // A visit that has already started occupies its time regardless — free-time
  // search excludes the past and would refuse every after-visit correction.
  const at = m.moscowParts(record.datetime);
  if ((compositionChanged || lengthChanged) && !(at && at.ms <= Date.now())) {
    if (!at) m.fail('Некорректное время записи.', 409);
    const draft = { staffId: Number(record.staff_id), date: at.date, time: at.time,
      ...(edit.seanceLength !== undefined ? { durationOverride: edit.seanceLength } : {}),
      ...(edit.technicalBreak !== undefined ? { technicalBreak: edit.technicalBreak } : {}) };
    const available = await availability(salon, draft, { ...record, ...(out.services ? { services: out.services } : {}) }, src);
    if (!available.slots.includes(at.time)) {
      m.fail(compositionChanged ? 'Новый состав услуг недоступен в этом времени. Перенесите запись.' : 'Новая длительность не помещается: время занято.', 409, 'slot_taken');
    }
  }
  return out;
}
```

- [ ] **Step 4: Реализация `model.js` и `index.js`**

`model.js`, в `parseDraft`, в ветке `if (action === 'create') {` сразу после строки `if (out.comment.length > 1000) fail('Комментарий слишком длинный.');` вставить:

```js
      if (body.notifyClient !== undefined) {
        if (typeof body.notifyClient !== 'boolean') fail('Некорректный флаг уведомления.');
        out.notifyClient = body.notifyClient;
      }
```

`model.js`, перед `const mins = t =>` вставить:

```js
// What a full PUT /record must carry back so that a move or a status change
// does not wipe colour, labels and the technical break set in YClients.
function recordExtras(r) {
  const out = {};
  if (typeof r.custom_color === 'string' && r.custom_color) out.custom_color = r.custom_color;
  if (Array.isArray(r.record_labels)) out.record_labels = normalizeLabels(r.record_labels).map(l => l.id);
  if (Number(r.technical_break_duration) > 0) out.technical_break_duration = Number(r.technical_break_duration);
  return out;
}
```
и добавить `recordExtras` в `module.exports`.

`index.js`, функция `prepare` — три правки:
1. В ветке `if (draft.action === 'edit') {` строку
```js
      attendance: record.attendance, ...patch, save_if_busy: false, send_sms: false };
```
заменить на
```js
      attendance: record.attendance, ...m.recordExtras(record), ...patch, save_if_busy: false, send_sms: false };
```
2. В ветке create/move строку
```js
        client: record.client, services: record.services, comment: record.comment || '', attendance: record.attendance,
```
заменить на
```js
        client: record.client, services: record.services, comment: record.comment || '', attendance: record.attendance,
        ...m.recordExtras(record),
```
3. В теле статусов (`const body = { staff_id: record.staff_id, …`) строку
```js
    comment: record.comment || '', attendance: draft.action === 'confirm' ? 2 : -1,
```
заменить на
```js
    comment: record.comment || '', attendance: draft.action === 'confirm' ? 2 : -1, ...m.recordExtras(record),
```

- [ ] **Step 5: Зелёные + базовая линия**

Run: `npx jest backend/journal-record-edit backend/journal-model backend/journal-service backend/journal-sessions --silent`
Expected: PASS.
Run: `npx jest backend/journal service-catalog finance bonus-ledger --silent`
Expected: 26 наборов зелёные.

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add backend/services/journal/record-edit.js backend/services/journal/model.js backend/services/journal/index.js backend/journal-record-edit.test.js backend/journal-model.test.js backend/journal-service.test.js && git commit -m "feat(journal): правка комментария, длительности, клиента, цвета, меток и технического перерыва

record-edit проверяет поля и собирает тело PUT; длительность и клиент
пришедшего визита не меняются. Полный PUT несёт обратно цвет, метки и
перерыв записи, чтобы перенос/статус их не стирал. create.notifyClient.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

#### Task 3c: Сессия проверяет новые поля локально, наложение их показывает

**Files:**
- Modify: `backend/services/journal/sessions.js` (`validate`, ветка существующей записи)
- Modify: `backend/services/journal/overlay.js` (`applyOverlay`, ветка `patch`)
- Test: `backend/journal-sessions.test.js`, `backend/journal-overlay.test.js`

- [ ] **Step 1: Падающие тесты**

В конец `backend/journal-sessions.test.js`:

```js
describe('edit: parity fields (12.11.2026)', () => {
  test('all new fields go into the edit step; the overlay shows them before sending', async () => {
    sources.forSalon.mockResolvedValueOnce({ kind: 'local', services: jest.fn(async () => []), labels: jest.fn(async () => [{ id: 3, title: 'VIP' }]) });
    const edit = { comment: 'Позвонить', customColor: '#F4A0A0', labelIds: [3], technicalBreak: 600, notifyClient: false, seanceLength: 75 };
    const out = await s.validate(3, parse({ recordId: 42, edit }));
    expect(out.steps).toEqual([expect.objectContaining({ kind: 'edit',
      params: { comment: 'Позвонить', customColor: '#f4a0a0', labelIds: [3], technicalBreak: 600, notifyClient: false, seanceLength: 75 } })]);
    expect(out.overlay.patch).toEqual({ comment: 'Позвонить', custom_color: '#f4a0a0', record_labels: [3], technical_break_duration: 600,
      seance_length: 4500, notify_client: false });
    expect(index.availability).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ durationOverride: 75, technicalBreak: 600, time: '10:00', staffId: 5 }), expect.anything(), expect.anything());
  });
  test('move together with a longer duration checks the new place with the new length', async () => {
    const out = await s.validate(3, parse({ recordId: 42, move: { date: '2030-04-01', time: '11:00', staffId: 5 }, edit: { seanceLength: 90 } }));
    expect(out.steps.map(x => x.kind)).toEqual(['move', 'edit']);
    expect(index.availability.mock.calls[0][1]).toMatchObject({ action: 'move', time: '11:00', durationOverride: 90 });
    expect(out.overlay.patch).toMatchObject({ datetime: '2030-04-01T11:00:00+03:00', seance_length: 5400 });
  });
  test('notifyClient alone is a valid edit and does not touch the visit', async () => {
    const out = await s.validate(3, parse({ recordId: 42, edit: { notifyClient: false } }));
    expect(out.overlay.patch).toEqual({ notify_client: false });
    expect(index.availability).not.toHaveBeenCalled();
  });
  test('client change of an arrived visit is refused locally', async () => {
    setup({ record: { ...RECORD, attendance: 1 } });
    await expect(s.validate(3, parse({ recordId: 42, edit: { client: { name: 'Анна', phone: '79200255591' } } }))).rejects.toMatchObject({ status: 409 });
  });
});
```

В конец `backend/journal-overlay.test.js`:

```js
test('patch carries parity fields (12.11.2026)', () => {
  const p = { comment: 'Позвонить', client: { name: 'Новый', phone: '79200255591' }, custom_color: '#f4a0a0', record_labels: [3],
    technical_break_duration: 600, notify_client: false, seance_length: 4500 };
  const [out] = applyOverlay([rec], [row({ yclients_record_id: 8, overlay: { kind: 'patch', patch: p } })], NOW);
  expect(out).toMatchObject(p);
  expect(m.normalizeRecord(out)).toMatchObject({ comment: 'Позвонить', clientName: 'Новый', customColor: '#f4a0a0',
    labels: [{ id: 3, title: '', color: '' }], technicalBreak: 600, duration: 75 });
});
```

- [ ] **Step 2: Запустить — падают**

Run: `npx jest backend/journal-sessions backend/journal-overlay --silent`
Expected: FAIL — нет `notify_client` в наложении, у перемещения нет `durationOverride`, наложение не переносит `comment`/`client`/`custom_color`.

- [ ] **Step 3: Реализация**

`sessions.js`, функция `validate`, ветка `if (session.move) {`: строку
```js
      const draft = { action: 'move', recordId: session.recordId, ...session.move };
```
заменить на
```js
      // A move saved together with a new length/break is checked with them.
      const draft = { action: 'move', recordId: session.recordId, ...session.move,
        ...(session.edit?.seanceLength !== undefined ? { durationOverride: session.edit.seanceLength } : {}),
        ...(session.edit?.technicalBreak !== undefined ? { technicalBreak: session.edit.technicalBreak } : {}) };
```
В ветке `if (session.edit) {` после строки `Object.assign(patch, await require('./record-edit').patch(…));` добавить:
```js
      // Display only: the worker builds the YClients body itself; the flag goes
      // to journal_record_prefs (task 5), never into PUT /record.
      if (session.edit.notifyClient !== undefined) patch.notify_client = session.edit.notifyClient;
```

`overlay.js`, в `applyOverlay` строку
```js
      for (const f of ['datetime', 'staff_id', 'seance_length', 'attendance', 'services']) if (p[f] !== undefined) next[f] = p[f];
```
заменить на
```js
      for (const f of ['datetime', 'staff_id', 'seance_length', 'attendance', 'services', 'comment', 'client',
        'custom_color', 'record_labels', 'technical_break_duration', 'notify_client']) if (p[f] !== undefined) next[f] = p[f];
```

- [ ] **Step 4: Зелёные + базовая линия**

Run: `npx jest backend/journal-sessions backend/journal-overlay --silent` → PASS.
Run: `npx jest backend/journal service-catalog finance bonus-ledger --silent` → 26 наборов зелёные.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/journal/sessions.js backend/services/journal/overlay.js backend/journal-sessions.test.js backend/journal-overlay.test.js && git commit -m "feat(journal): сессия формы принимает новые поля правки, наложение показывает их до отправки

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 4: Сервер — удаление записи (`status:'delete'` → шаг `delete`) и `api_id` у создания

> **Поправка 13.11.2026 (живой прогон):** YClients хранит `api_id` только числом — `lp-outbox-43` сохранился как `"0"`. Фактический формат — числовой id пакета (`'43'`, `prefs.apiIdFor`, `prefs.API_ID = /^\d{1,15}$/`); `enroll.js` считает пакет своим, только если у него есть шаг `create` и `yclients_record_id` пуст или равен id записи. Код ниже — исходный вариант плана с `<числовой id пакета>`, актуальный — в коде.

**Исполнитель:** Opus. **Зависимости:** T3.

**Files:**
- Modify: `backend/services/journal/yclients.js` (новая `remove`, `module.exports`)
- Modify: `backend/services/journal/index.js` (`prepare`, `mutate`)
- Modify: `backend/services/journal/sessions.js` (`parseSession`, `validate`)
- Modify: `backend/services/journal/overlay.js` (`deleted`)
- Modify: `backend/services/journal/outbox-worker.js` (`runStep`, `processPackage`)
- Modify: `backend/migrations.js:8-13` (ограничение `journal_operations.action`)
- Create: `backend/journal-yclients-remove.test.js`
- Test: `backend/journal-sessions.test.js`, `backend/journal-service.test.js`, `backend/journal-outbox-worker.test.js`, `backend/journal-overlay.test.js`, `backend/journal-local-ddl.test.js`

Решения, которые нельзя «упростить»:
- **Удаление идёт через `index.mutate`**, а не прямым вызовом из воркера: `mutate` даёт блокировку салона, строку `journal_operations` (idempotency по opId) и сверку версии записи. Отсюда вынужденная миграция ограничения `journal_operations.action` (готча 7).
- **`api_id` передаётся в `mutate` четвёртым аргументом `opts`, а НЕ полем черновика.** `mutate` фингерпринтит черновик (`request_hash`); если бы `apiId` попал в черновик, пакет создания, начатый до выката и повторённый после, получил бы другой хэш → «Ключ операции уже использован» → `uncertain` (невосстановимо без сверки).
- «Уже удалена» = `getRecord` вернул `deleted:true`, или 404 при чтении, или 404/409 на `DELETE` → шаг `done` без повторного вызова (идемпотентно, спека §6).
- Удаление пришедшего (`attendance=1`) или оплаченного визита — отказ (спека §4.1, §6); отменённый (`-1`) удалять можно.
- `status:'delete'` можно отправить ВМЕСТЕ с `edit` (карточка шлёт свои несохранённые правки и удаление одной сессией — задача 12), но не с оплатами и не с переносом. Шаг `delete` — последний (`buildSteps` уже ставит статус после `edit`, а оплаты запрещены).

- [ ] **Step 1: Падающие тесты**

Создать `backend/journal-yclients-remove.test.js`:

```js
'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret', YC: 'https://api.yclients.test/api/v1' }));
jest.mock('axios', () => jest.fn());
jest.mock('./services/yclients', () => ({ ycGet: jest.fn(), ycHeaders: () => ({ Authorization: 'synthetic' }) }));
const axios = require('axios');
const yc = require('./services/journal/yclients');
const salon = { id: 3, yclients_company_id: 77 };
beforeEach(() => axios.mockReset());
test('DELETE /record/{cid}/{id}', async () => {
  axios.mockResolvedValue({ status: 204, data: '' });
  expect(await yc.remove(salon, 500)).toEqual({ recordId: 500 });
  expect(axios).toHaveBeenCalledWith(expect.objectContaining({ method: 'delete', url: 'https://api.yclients.test/api/v1/record/77/500', timeout: 30000 }));
});
test.each([404, 409])('%s from YClients = already deleted', async status => {
  axios.mockRejectedValue(Object.assign(new Error('x'), { response: { status } }));
  expect(await yc.remove(salon, 500)).toEqual({ recordId: 500, alreadyDeleted: true });
});
test('success:false and other statuses are errors', async () => {
  axios.mockResolvedValue({ status: 200, data: { success: false } });
  await expect(yc.remove(salon, 500)).rejects.toThrow('upstream_delete_failed');
  axios.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 422 } }));
  await expect(yc.remove(salon, 500)).rejects.toMatchObject({ response: { status: 422 } });
});
```

В `backend/journal-service.test.js` в фабрике мока YClients (строка 5) заменить
```js
jest.mock('./services/journal/yclients', () => ({ list: jest.fn(), records: jest.fn(), getRecord: jest.fn(), write: jest.fn() }));
```
на
```js
jest.mock('./services/journal/yclients', () => ({ list: jest.fn(), records: jest.fn(), getRecord: jest.fn(), write: jest.fn(), remove: jest.fn() }));
```
и в блок `describe('parity fields (12.11.2026)', …)` добавить:

```js
  test('delete calls DELETE once; an already deleted record is not called again', async () => {
    yc.remove.mockResolvedValue({ recordId: 8 });
    expect(await service.mutate(3, 4, { operationId, action: 'delete', recordId: 8, version: m.revision(record) })).toEqual({ recordId: 8 });
    expect(yc.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), 8);
    expect(yc.write).not.toHaveBeenCalled();
    const insert = conn.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO journal_operations'));
    expect(insert[1][3]).toBe('delete');
    yc.remove.mockClear();
    const gone = { ...record, deleted: true };
    yc.getRecord.mockResolvedValue(structuredClone(gone));
    expect(await service.mutate(3, 4, { operationId: '22345678-1234-4123-8123-123456789012', action: 'delete', recordId: 8, version: m.revision(gone) }))
      .toEqual({ recordId: 8, alreadyDeleted: true });
    expect(yc.remove).not.toHaveBeenCalled();
  });
  test('delete refuses an arrived or a paid visit and a stale version', async () => {
    for (const rec of [{ ...record, attendance: 1 }, { ...record, paid_amount: 100 }]) {
      yc.getRecord.mockResolvedValue(structuredClone(rec));
      await expect(service.mutate(3, 4, { operationId, action: 'delete', recordId: 8, version: m.revision(rec) })).rejects.toMatchObject({ status: 409 });
    }
    yc.getRecord.mockResolvedValue(structuredClone(record));
    await expect(service.mutate(3, 4, { operationId, action: 'delete', recordId: 8, version: '0'.repeat(64) })).rejects.toMatchObject({ code: 'stale' });
    expect(yc.remove).not.toHaveBeenCalled();
  });
  test('create sends api_id from opts; the request hash does not depend on it', async () => {
    const d = { operationId, action: 'create', date: '2030-04-01', time: '09:00', staffId: 1, serviceIds: [7], clientName: 'Тест', clientPhone: '70000000000', comment: '' };
    await service.mutate(3, 4, d, { apiId: '15' });
    expect(yc.write.mock.calls[0][2].api_id).toBe('15');
    const hashWith = conn.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO journal_operations'))[1][5];
    expect(hashWith).toBe(m.fingerprint(d));
    yc.write.mockClear();
    await service.mutate(3, 4, { ...d, operationId: '32345678-1234-4123-8123-123456789012' }, { apiId: 'evil; DROP' });
    expect(yc.write.mock.calls[0][2]).not.toHaveProperty('api_id');
  });
```

В конец `backend/journal-sessions.test.js`:

```js
describe('delete (12.11.2026)', () => {
  test('parse: delete alone or with edit; not with payments, move or create', () => {
    expect(parse({ recordId: 42, status: 'delete' })).toMatchObject({ status: 'delete' });
    expect(parse({ recordId: 42, status: 'delete', edit: { notifyClient: false } })).toMatchObject({ status: 'delete', edit: { notifyClient: false } });
    expect(() => parse({ recordId: 42, status: 'delete', payments: [pay('account', 10, 100)] })).toThrow('Удалённую запись нельзя оплатить');
    expect(() => parse({ recordId: 42, status: 'delete', move: { date: '2030-04-01', time: '11:00', staffId: 5 } })).toThrow('Нельзя одновременно перенести и удалить');
    expect(() => parse({ recordId: 42, status: 'confirm', edit: { comment: 'x' } })).toThrow('отдельно');
    expect(() => parse({ create: CREATE, status: 'delete' })).toThrow('сохранённой');
  });
  test('validate: delete is the last step and hides the record in the overlay', async () => {
    const out = await s.validate(3, parse({ recordId: 42, status: 'delete', edit: { notifyClient: false } }));
    expect(out.steps.map(x => x.kind)).toEqual(['edit', 'delete']);
    expect(out.overlay.patch).toEqual({ notify_client: false, deleted: true });
  });
  test('validate: arrived or paid visit cannot be deleted; a cancelled one can', async () => {
    setup({ record: { ...RECORD, attendance: 1 } });
    await expect(s.validate(3, parse({ recordId: 42, status: 'delete' }))).rejects.toMatchObject({ status: 409 });
    setup({ record: { ...RECORD, attendance: -1 } });
    await expect(s.validate(3, parse({ recordId: 42, status: 'delete' }))).resolves.toMatchObject({ overlay: { patch: { deleted: true } } });
    setup({ record: { ...RECORD, deleted: true } });
    await expect(s.validate(3, parse({ recordId: 42, status: 'delete' }))).rejects.toMatchObject({ status: 409 });
  });
});
```

В конец `backend/journal-overlay.test.js`:

```js
test('delete patch marks the record deleted: the day drops it, the card says so', () => {
  const [out] = applyOverlay([rec], [row({ yclients_record_id: 8, overlay: { kind: 'patch', patch: { deleted: true } } })], NOW);
  expect(out.deleted).toBe(true);
  expect(m.recordsForDay([out], '2030-04-01')).toEqual([]);
});
```

В `describe('processPackage', …)` файла `backend/journal-outbox-worker.test.js` добавить:

```js
  test('delete step goes through mutate with the live version (12.11.2026)', async () => {
    const live = { id: 42, datetime: '2030-04-01T10:00:00+03:00', staff_id: 5, attendance: 0 };
    yc.getRecord.mockResolvedValue(live);
    expect(await w.processPackage(pkg([step('delete', 1)], { yclients_record_id: 42 }))).toBe('done');
    expect(calls[0][2]).toEqual({ operationId: OP(1), action: 'delete', recordId: 42, version: m.revision(live) });
  });
  test('delete of a record YClients no longer has (404) is done without mutate', async () => {
    yc.getRecord.mockRejectedValue(new m.JournalError(404, 'Запись не найдена.'));
    expect(await w.processPackage(pkg([step('delete', 1)], { yclients_record_id: 42 }))).toBe('done');
    expect(index.mutate).not.toHaveBeenCalled();
    expect(stepsOf(lastWrite(/status='done'/))[0].result).toEqual({ recordId: 42, alreadyDeleted: true });
  });
  test('create passes api_id = numeric package id outside the draft', async () => {
    await w.processPackage(pkg([step('create', 1, CREATE_PARAMS)]));
    expect(index.mutate.mock.calls[0][3]).toEqual({ apiId: '11' });
    expect(index.mutate.mock.calls[0][2]).not.toHaveProperty('apiId');
  });
```

В конец `backend/journal-local-ddl.test.js`:

```js
test('journal_operations accepts the delete action (v3 constraint, v2 block guarded)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'migrations.js'), 'utf8');
  expect(src).toContain("journal_operations_action_v3_check CHECK (action IN ('create','move','cancel','confirm','edit','delete'))");
  // The v2 block must not run again after v3 dropped the v2 constraint
  // (it would DROP a constraint that no longer exists and fail every start).
  expect(src).toMatch(/conname='journal_operations_action_v2_check'\)\s*AND NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conrelid='journal_operations'::regclass AND conname='journal_operations_action_v3_check'\)/);
});
```

- [ ] **Step 2: Запустить — падают**

Run: `cd /root/loyalpro/backend && npx jest backend/journal-yclients-remove backend/journal-service backend/journal-sessions backend/journal-overlay backend/journal-outbox-worker backend/journal-local-ddl --silent`
Expected: FAIL — `yc.remove is not a function`, «Неизвестный статус записи», «Неизвестный шаг пакета», нет `_v3_check`.

- [ ] **Step 3: `yclients.js` — `remove`**

Перед `module.exports` вставить:

```js
// DELETE /record. «Already deleted» (404, or 409 for a record YClients
// considers gone) is a success: a repeated package must not fail on it.
async function remove(salon, id) {
  const authSalon = config.YCLIENTS_INTEGRATION_USER_TOKEN
    ? { ...salon, yclients_user_token: config.YCLIENTS_INTEGRATION_USER_TOKEN } : salon;
  let response;
  try {
    response = await axios({ method: 'delete', url: `${config.YC}/record/${salon.yclients_company_id}/${id}`,
      headers: ycHeaders(authSalon), timeout: 30000 });
  } catch (e) {
    const status = e?.response?.status;
    if (status === 404 || status === 409) return { recordId: id, alreadyDeleted: true };
    throw e;
  }
  if (response?.data && typeof response.data === 'object' && response.data.success === false) throw new Error('upstream_delete_failed');
  return { recordId: id };
}
```
и в `module.exports` добавить `remove`.

- [ ] **Step 4: `index.js` — `prepare` и `mutate`**

В начало функции `prepare` (сразу после строки `async function prepare(salon, draft) {`) — заменить заголовок на `async function prepare(salon, draft, opts = {}) {` и вставить первым блоком:

```js
  if (draft.action === 'delete') {
    let rec;
    try { rec = await yc.getRecord(salon, draft.recordId); }
    catch (e) { if (e instanceof m.JournalError && e.status === 404) return { alreadyDeleted: true }; throw e; }
    if (rec.deleted) return { alreadyDeleted: true };
    if (m.revision(rec) !== draft.version) m.fail('Запись изменилась. Откройте карточку заново.', 409, 'stale');
    if (rec.paid_full || Number(rec.paid_amount) > 0) m.fail('Сначала удалите оплаты визита.', 409);
    if (Number(rec.attendance) === 1) m.fail('Пришедший визит удаляйте в YClients.', 409);
    return {};
  }
```

В той же функции, в возвращаемом объекте ветки create/move, после строки `seance_length: available.duration * 60, save_if_busy: false, send_sms: false,` добавить:

```js
      // Our package id travels with the new record: the create webhook can
      // arrive before we know the record id (notifications, task 5).
      ...(!record && prefs.API_ID.test(String(opts.apiId || '')) ? { api_id: opts.apiId } : {}),
```

Функция `mutate`: заголовок `async function mutate(salonId, userId, draft) {` → `async function mutate(salonId, userId, draft, opts = {}) {`. Строку `const requestHash = m.fingerprint(draft);` НЕ трогать (хэш — только от черновика). Заменить

```js
    const body = await prepare(salon, draft);
    if (draft.recordId && m.revision(await yc.getRecord(salon, draft.recordId)) !== draft.version) {
```
на
```js
    const body = await prepare(salon, draft, opts);
    if (draft.recordId && !body?.alreadyDeleted && m.revision(await yc.getRecord(salon, draft.recordId)) !== draft.version) {
```
и строку
```js
      result = await yc.write(salon, draft.recordId, body);
```
на
```js
      result = draft.action !== 'delete' ? await yc.write(salon, draft.recordId, body)
        : body.alreadyDeleted ? { recordId: draft.recordId, alreadyDeleted: true }
        : await yc.remove(salon, draft.recordId);
```

- [ ] **Step 5: `sessions.js`**

В `parseSession`:
- строку `if (present(body.status) || body.payments?.length || body.removePayments?.length) m.fail('Сохраните изменения записи отдельно от оплат.');` заменить на
```js
    // Delete may carry the card's unsaved edit (e.g. «не уведомлять»); other statuses and payments go separately.
    if ((present(body.status) && body.status !== 'delete') || body.payments?.length || body.removePayments?.length) m.fail('Сохраните изменения записи отдельно от оплат.');
```
- строку `if (!['confirm', 'cancel'].includes(body.status)) m.fail('Неизвестный статус записи.');` заменить на `if (!['confirm', 'cancel', 'delete'].includes(body.status)) m.fail('Неизвестный статус записи.');`
- после строки `if (out.move && out.status === 'cancel') m.fail('Нельзя одновременно перенести и отменить запись.');` вставить:
```js
  if (out.move && out.status === 'delete') m.fail('Нельзя одновременно перенести и удалить запись.');
```
- после строки `if (out.status === 'cancel' && (out.payments.length || out.removePayments.length)) m.fail('Отменённый визит нельзя оплатить.');` вставить:
```js
  if (out.status === 'delete' && (out.payments.length || out.removePayments.length)) m.fail('Удалённую запись нельзя оплатить.');
```

В `validate` (ветка существующей записи):
- строку `if (record.deleted || (!session.edit && Number(record.attendance) === -1)) m.fail('Запись уже отменена или удалена.', 409);` заменить на
```js
    // A cancelled visit (-1) can still be deleted; a deleted one cannot be changed at all.
    if (record.deleted || (!session.edit && session.status !== 'delete' && Number(record.attendance) === -1)) m.fail('Запись уже отменена или удалена.', 409);
```
- после строки `if (session.status === 'cancel') patch.cancel = true;` вставить:
```js
    if (session.status === 'delete') patch.deleted = true;
```
(Проверка «Пришедшие и оплаченные визиты изменяйте в YClients» уже срабатывает, потому что `session.status` непуст.)

- [ ] **Step 6: `overlay.js`**

После строки `if (p.cancel === true) next.attendance = -1;` вставить:
```js
      // Deleted locally: the day drops it (recordsForDay), the card shows «удалена (ждёт отправки)».
      if (p.deleted === true) next.deleted = true;
```

- [ ] **Step 7: `outbox-worker.js`**

В `runStep`:
- в ветке `if (step.kind === 'create') {` строку
```js
    const r = await index.mutate(salonId, userId, { ...params, operationId: step.opId, action: 'create' });
```
заменить на
```js
    // api_id rides OUTSIDE the draft: the draft's fingerprint must stay the same
    // for packages started before this field existed.
    const r = await index.mutate(salonId, userId, { ...params, operationId: step.opId, action: 'create' }, { apiId: prefs.apiIdFor(ctx.outboxId) });
```
- строку `if (['move', 'confirm', 'cancel', 'edit'].includes(step.kind)) {` заменить на `if (['move', 'confirm', 'cancel', 'edit', 'delete'].includes(step.kind)) {`
- внутри этой ветки строку
```js
      const live = await yc.getRecord(ctx.salon, recordId);
```
заменить на
```js
      let live;
      try { live = await yc.getRecord(ctx.salon, recordId); }
      catch (e) {
        // Deleting a record YClients no longer has is done (spec §6).
        if (step.kind === 'delete' && e instanceof m.JournalError && e.status === 404) return { recordId, alreadyDeleted: true };
        throw e;
      }
```
- в той же ветке строку `const r = await index.mutate(salonId, userId, draft);` заменить на
```js
    const r = await index.mutate(salonId, userId, draft);
    if (r?.alreadyDeleted) return { recordId, alreadyDeleted: true };
```

В `processPackage` в объект `ctx` после `salon: null,` добавить строку `outboxId: Number(row.id),`.

- [ ] **Step 8: `migrations.js`**

Блок в начале `runMigrations` (строки ~9–13)
```js
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='journal_operations'::regclass AND conname='journal_operations_action_v2_check') THEN
```
заменить на
```js
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='journal_operations'::regclass AND conname='journal_operations_action_v2_check')
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='journal_operations'::regclass AND conname='journal_operations_action_v3_check') THEN
```
(остаток блока не трогать), и сразу ПОСЛЕ этого `await client.query(…);` вставить:

```js
  // Journal record deletion (12.11.2026): the outbox «delete» step goes through
  // mutate(), which audits it in journal_operations. Expand only once.
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='journal_operations'::regclass AND conname='journal_operations_action_v3_check') THEN
      ALTER TABLE journal_operations DROP CONSTRAINT IF EXISTS journal_operations_action_v2_check,
        DROP CONSTRAINT IF EXISTS journal_operations_action_check,
        ADD CONSTRAINT journal_operations_action_v3_check CHECK (action IN ('create','move','cancel','confirm','edit','delete'));
    END IF;
  END $$`);
```

- [ ] **Step 9: Зелёные + базовая линия + миграция на деве**

Run: `npx jest backend/journal-yclients-remove backend/journal-service backend/journal-sessions backend/journal-overlay backend/journal-outbox-worker backend/journal-local-ddl --silent` → PASS.
Run: `npx jest backend/journal service-catalog finance bonus-ledger --silent` → зелёные (27 наборов: +1 новый).
Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 5 && pm2 logs loyalpro --lines 80 --nostream | grep -i -E "migrat|journal_operations|error" | tail -20`
Expected: нет ошибок про `journal_operations`/ограничения; второй рестарт (`PORT=3001 pm2 restart loyalpro`) тоже без ошибок (проверяет, что блок v2 больше не выполняется).

- [ ] **Step 10: Commit**

```bash
cd /root/loyalpro && git add backend/services/journal/yclients.js backend/services/journal/index.js backend/services/journal/sessions.js backend/services/journal/overlay.js backend/services/journal/outbox-worker.js backend/migrations.js backend/journal-yclients-remove.test.js backend/journal-service.test.js backend/journal-sessions.test.js backend/journal-overlay.test.js backend/journal-outbox-worker.test.js backend/journal-local-ddl.test.js && git commit -m "feat(journal): удаление записи шагом delete и api_id пакета у создания

status:'delete' — последний шаг, несовместим с оплатами и переносом;
пришедший/оплаченный визит не удаляется. Уже удалённая запись (deleted,
404, 409) — шаг done. create уходит с api_id=<числовой id пакета> вне
черновика (хэш операции не меняется). journal_operations: ограничение v3.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 5: «Не уведомлять клиента» — `journal_record_prefs`, воркер, `notifications/enroll.js`

> **Поправка 13.11.2026 (живой прогон):** YClients хранит `api_id` только числом — `lp-outbox-43` сохранился как `"0"`. Фактический формат — числовой id пакета (`'43'`, `prefs.apiIdFor`, `prefs.API_ID = /^\d{1,15}$/`); `enroll.js` считает пакет своим, только если у него есть шаг `create` и `yclients_record_id` пуст или равен id записи. Код ниже — исходный вариант плана с `<числовой id пакета>`, актуальный — в коде.

**Исполнитель:** Opus. **Зависимости:** T4 (`api_id`, `ctx.outboxId`).

**Files:**
- Create: `backend/services/journal/record-prefs.js`
- Create: `backend/journal-record-prefs.test.js`
- Modify: `backend/migrations.js` (константа `JOURNAL_PREFS_DDL` рядом с `JOURNAL_LOCAL_DDL`, вызов в `runMigrations`, `module.exports`)
- Modify: `backend/services/journal/outbox-worker.js` (`runStep`)
- Modify: `backend/services/journal/index.js` (`detail` → поле `notifyClient`)
- Modify: `backend/services/notifications/events.js` (`recordSnapshot` → `apiId`)
- Modify: `backend/services/notifications/enroll.js` (`enrollEvent`)
- Test: `backend/journal-outbox-worker.test.js`, `backend/journal-service.test.js`, `backend/journal-local-ddl.test.js`, `backend/notifications-enroll.test.js`

Как это работает (спека §4.3): в YClients всегда `send_sms:false`; клиенту пишет наш модуль уведомлений по вебхукам. Флаг «не уведомлять» = строка `journal_record_prefs(notify_client=false)`. Для существующей записи воркер пишет строку ДО `PUT` (вебхук приходит после). Для новой записи id неизвестен до ответа `POST /records`, а вебхук `create` может опередить нашу запись строки — поэтому `enroll.js` при отсутствии строки смотрит `data.api_id` = числовой id пакета (защита от чужого api_id — по `yclients_record_id` пакета) → `journal_outbox.steps[create].params.notifyClient`. `false` → новые job'ы ложатся `skipped` с причиной `journal_opt_out`, а уже стоящие `pending` этой записи гасятся (флаг мог быть поставлен после того, как напоминание встало в очередь). Проверка best-effort: любой сбой → `false` (уведомление идёт как раньше) + WARN в лог. Догон `backfillReminders` флаг НЕ проверяет (вне рамок v1: он обрабатывает записи, созданные до включения модуля).

- [ ] **Step 1: Падающие тесты модуля и миграции**

Создать `backend/journal-record-prefs.test.js`:

```js
'use strict';
jest.mock('./db', () => ({ db: { oneOrNone: jest.fn(), query: jest.fn() } }));
jest.mock('./logger', () => { const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }; return { createLogger: () => log, __log: log }; });
const { db } = require('./db');
const { __log: log } = require('./logger');
const prefs = require('./services/journal/record-prefs');
beforeEach(() => { jest.clearAllMocks(); db.query.mockResolvedValue({ rowCount: 1 }); });
test('write upserts the flag with the package id, scoped by salon', async () => {
  await prefs.write(3, 500, false, 11);
  const [sql, args] = db.query.mock.calls[0];
  expect(sql).toMatch(/INSERT INTO journal_record_prefs/);
  expect(sql).toMatch(/ON CONFLICT \(salon_id,yclients_record_id\) DO UPDATE/);
  expect(args).toEqual([3, 500, false, 11]);
});
test('apiIdFor builds <числовой id пакета>', () => expect(prefs.apiIdFor(15)).toBe('15'));
describe('optOutForEvent', () => {
  test('row wins', async () => {
    db.oneOrNone.mockResolvedValueOnce({ notify_client: false });
    expect(await prefs.optOutForEvent(3, 500, '15')).toBe(true);
    expect(db.oneOrNone).toHaveBeenCalledTimes(1);
    db.oneOrNone.mockResolvedValueOnce({ notify_client: true });
    expect(await prefs.optOutForEvent(3, 500, '15')).toBe(false);
  });
  test('no row: api_id → package of THIS salon → create step flag', async () => {
    db.oneOrNone.mockResolvedValueOnce(null).mockResolvedValueOnce({ steps: [{ kind: 'create', params: { notifyClient: false } }] });
    expect(await prefs.optOutForEvent(3, 500, '15')).toBe(true);
    expect(db.oneOrNone.mock.calls[1][1]).toEqual([3, 15]);
    db.oneOrNone.mockResolvedValueOnce(null).mockResolvedValueOnce({ steps: [{ kind: 'create', params: {} }] });
    expect(await prefs.optOutForEvent(3, 500, '15')).toBe(false);
  });
  test('foreign or missing api_id never reads the outbox', async () => {
    for (const apiId of ['', null, 'site-15', 'lp-outbox-', 'lp-outbox-1;DROP']) {
      db.oneOrNone.mockReset(); db.oneOrNone.mockResolvedValueOnce(null);
      expect(await prefs.optOutForEvent(3, 500, apiId)).toBe(false);
      expect(db.oneOrNone).toHaveBeenCalledTimes(1);
    }
  });
  test('a DB failure means «notify as before»', async () => {
    db.oneOrNone.mockRejectedValueOnce(new Error('boom'));
    expect(await prefs.optOutForEvent(3, 500, null)).toBe(false);
    expect(log.warn).toHaveBeenCalled();
  });
});
```

В конец `backend/journal-local-ddl.test.js`:

```js
test('journal_record_prefs DDL is additive and tenant-scoped', () => {
  const { JOURNAL_PREFS_DDL } = require('./migrations');
  expect(JOURNAL_PREFS_DDL).toContain('CREATE TABLE IF NOT EXISTS journal_record_prefs');
  expect(JOURNAL_PREFS_DDL).toContain('PRIMARY KEY (salon_id, yclients_record_id)');
  expect(JOURNAL_PREFS_DDL).toContain('notify_client BOOLEAN NOT NULL DEFAULT TRUE');
  expect(JOURNAL_PREFS_DDL).not.toMatch(/DROP|TRUNCATE|DELETE FROM|CREATE INDEX/);
});
```

- [ ] **Step 2: Запустить — падают**

Run: `cd /root/loyalpro/backend && npx jest backend/journal-record-prefs backend/journal-local-ddl --silent`
Expected: FAIL — `Cannot find module './services/journal/record-prefs'`, `JOURNAL_PREFS_DDL` undefined.

- [ ] **Step 3: Реализация модуля и миграции**

Создать `backend/services/journal/record-prefs.js`:

```js
'use strict';
// «Не уведомлять клиента» for a journal record (spec 2026-11-12 §4.3).
// The worker writes the flag BEFORE PUT /record (the webhook comes after).
// A new record has no id until POST /records answers and its create webhook
// may come first: it carries api_id = numeric package id, and the flag is
// read from that package's create step. Best effort: a failure = notify.
const { db } = require('../../db');
const logger = require('../../logger').createLogger('JournalPrefs');

const API_ID = /^\d{1,15}$/;
const apiIdFor = outboxId => String(Number(outboxId));

const UPSERT_SQL = `INSERT INTO journal_record_prefs(salon_id,yclients_record_id,notify_client,outbox_id,updated_at)
  VALUES($1,$2,$3,$4,NOW())
  ON CONFLICT (salon_id,yclients_record_id) DO UPDATE SET notify_client=EXCLUDED.notify_client, outbox_id=EXCLUDED.outbox_id, updated_at=NOW()`;
const GET_SQL = 'SELECT notify_client FROM journal_record_prefs WHERE salon_id=$1 AND yclients_record_id=$2';
const PACKAGE_SQL = 'SELECT steps FROM journal_outbox WHERE salon_id=$1 AND id=$2';

async function write(salonId, recordId, notifyClient, outboxId = null) {
  await db.query(UPSERT_SQL, [Number(salonId), Number(recordId), notifyClient !== false, outboxId == null ? null : Number(outboxId)]);
}
async function get(salonId, recordId) {
  return db.oneOrNone(GET_SQL, [Number(salonId), Number(recordId)]);
}
async function optOutForEvent(salonId, recordId, apiId) {
  try {
    const row = await get(salonId, recordId);
    if (row) return row.notify_client === false;
    const m = API_ID.exec(typeof apiId === 'string' ? apiId : '');
    if (!m) return false;
    const pkg = await db.oneOrNone(PACKAGE_SQL, [Number(salonId), Number(m[1])]);
    const create = (Array.isArray(pkg?.steps) ? pkg.steps : []).find(s => s && s.kind === 'create');
    return create?.params?.notifyClient === false;
  } catch (e) {
    logger.warn(`salon ${salonId} record ${recordId}: opt-out check failed (${e?.code || 'error'}), notifying as usual`);
    return false;
  }
}
module.exports = { write, get, optOutForEvent, apiIdFor, API_ID };
```

`migrations.js`: после константы `JOURNAL_LOCAL_DDL` (после её закрывающего `` `; ``) вставить:

```js
// «Не уведомлять клиента» for journal records (12.11.2026). Read by
// notifications/enroll.js; written by the journal outbox worker.
const JOURNAL_PREFS_DDL = `
CREATE TABLE IF NOT EXISTS journal_record_prefs (
 salon_id INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
 yclients_record_id BIGINT NOT NULL,
 notify_client BOOLEAN NOT NULL DEFAULT TRUE,
 outbox_id BIGINT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY (salon_id, yclients_record_id)
);
`;
```
в `runMigrations` после строки `await client.query(JOURNAL_LOCAL_DDL);` добавить `await client.query(JOURNAL_PREFS_DDL);`; в `module.exports` добавить `JOURNAL_PREFS_DDL`.

- [ ] **Step 4: Зелёные**

Run: `npx jest backend/journal-record-prefs backend/journal-local-ddl --silent` → PASS.

- [ ] **Step 5: Падающие тесты воркера, карточки и уведомлений**

В `backend/journal-outbox-worker.test.js` в `describe('processPackage', …)`:

```js
  test('edit with notifyClient writes journal_record_prefs BEFORE the PUT; a flag-only edit makes no PUT', async () => {
    yc.getRecord.mockResolvedValue({ id: 42, datetime: '2030-04-01T10:00:00+03:00', staff_id: 5, attendance: 0 });
    let prefsBeforePut = null;
    index.mutate.mockImplementation(async (s, u, d) => {
      calls.push(['mutate', d.action, d]);
      prefsBeforePut = writes.some(x => /INSERT INTO journal_record_prefs/.test(x.sql));
      return { recordId: d.recordId };
    });
    await w.processPackage(pkg([step('edit', 1, { comment: 'x', notifyClient: false })], { yclients_record_id: 42 }));
    expect(prefsBeforePut).toBe(true);
    expect(writes.find(x => /INSERT INTO journal_record_prefs/.test(x.sql)).args).toEqual([3, 42, false, 11]);
    calls = []; writes.length = 0;
    expect(await w.processPackage(pkg([step('edit', 2, { notifyClient: true })], { yclients_record_id: 42 }))).toBe('done');
    expect(calls).toEqual([]);
    expect(writes.find(x => /INSERT INTO journal_record_prefs/.test(x.sql)).args).toEqual([3, 42, true, 11]);
  });
  test('create with notifyClient:false records the flag for the new id', async () => {
    await w.processPackage(pkg([step('create', 1, { ...CREATE_PARAMS, notifyClient: false })]));
    expect(writes.find(x => /INSERT INTO journal_record_prefs/.test(x.sql)).args).toEqual([3, 500, false, 11]);
  });
  test('create without the flag writes no prefs row', async () => {
    await w.processPackage(pkg([step('create', 1, CREATE_PARAMS)]));
    expect(writes.some(x => /journal_record_prefs/.test(x.sql))).toBe(false);
  });
```

В блок `describe('parity fields (12.11.2026)', …)` файла `backend/journal-service.test.js`:

```js
  test('card shows «не уведомлять» from journal_record_prefs (default: notify)', async () => {
    expect((await service.detail(3, 8)).notifyClient).toBe(true);
    db.oneOrNone.mockImplementation(async sql => /journal_record_prefs/.test(sql) ? { notify_client: false } : { id: 3, yclients_company_id: 30 });
    expect((await service.detail(3, 8)).notifyClient).toBe(false);
  });
```

В конец `backend/notifications-enroll.test.js`:

```js
describe('журнал: «не уведомлять клиента» (12.11.2026)', () => {
  const withJournal = (fn) => {
    const base = db.oneOrNone.getMockImplementation();
    db.oneOrNone.mockImplementation(async (sql, p) => {
      const hit = await fn(sql, p);
      return hit === undefined ? base(sql, p) : hit;
    });
  };
  test('строка journal_record_prefs с notify_client=false → job skipped journal_opt_out, pending записи гасятся', async () => {
    setup({ rules: [rule()] });
    withJournal(async (sql) => (/journal_record_prefs/.test(sql) ? { notify_client: false } : undefined));
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0][9]).toBe('skipped');
    expect(inserts()[0][13]).toBe('journal_opt_out');
    expect(cancels().some((p) => p[2] === 'journal_opt_out')).toBe(true);
  });
  test('строки нет, api_id ведёт на пакет журнала с notifyClient:false → skipped', async () => {
    setup({ rules: [rule()] });
    withJournal(async (sql, p) => {
      if (/journal_record_prefs/.test(sql)) return null;
      if (/FROM journal_outbox/.test(sql)) { expect(p).toEqual([1, 77]); return { steps: [{ kind: 'create', params: { notifyClient: false } }] }; }
      return undefined;
    });
    await enroll.handleRecordEvent(salon, payload({ api_id: '77' }), NOW);
    expect(inserts()[0][9]).toBe('skipped');
    expect(inserts()[0][13]).toBe('journal_opt_out');
  });
  test('сбой проверки флага → уведомление ставится как раньше', async () => {
    setup({ rules: [rule()] });
    withJournal(async (sql) => { if (/journal_record_prefs/.test(sql)) throw new Error('boom'); return undefined; });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts()[0][9]).toBe('pending');
    expect(cancels()).toHaveLength(0);
  });
  test('чужой api_id не заглядывает в журнал', async () => {
    setup({ rules: [rule()] });
    await enroll.handleRecordEvent(salon, payload({ api_id: 'site-77' }), NOW);
    expect(db.oneOrNone.mock.calls.some(([sql]) => /FROM journal_outbox/.test(sql))).toBe(false);
    expect(inserts()[0][9]).toBe('pending');
  });
});
```

Готча мока: в `setup()` этого файла `db.oneOrNone` возвращает `null` на незнакомый SQL — значит существующие тесты видят «строки prefs нет, api_id нет» и ведут себя по-старому.

- [ ] **Step 6: Запустить — падают**

Run: `npx jest backend/journal-outbox-worker backend/journal-service backend/notifications-enroll --silent`
Expected: FAIL — нет записи `journal_record_prefs`, `notifyClient` undefined, `inserts()[0][9]` = `'pending'`.

- [ ] **Step 7: Реализация воркера и карточки**

`outbox-worker.js`: в начало файла после `const finOps = require('../finance-ops');` добавить `const prefs = require('./record-prefs');`.

В `runStep`, ветка `create`: после строки `ctx.recordId = recordId;` вставить:
```js
    // «Не уведомлять» for the new record; the create webhook may come first —
    // enroll.js then finds the flag through api_id (<числовой id пакета>).
    if (typeof p.notifyClient === 'boolean') await prefs.write(salonId, recordId, p.notifyClient, ctx.outboxId);
```

В ветке `if (['move', 'confirm', 'cancel', 'edit', 'delete'].includes(step.kind)) {` первыми строками (до `let draft = storedDraft(step);`) вставить:
```js
    if (step.kind === 'edit' && typeof p.notifyClient === 'boolean') {
      // BEFORE the PUT: its webhook must already see the flag. Idempotent on retry.
      await prefs.write(salonId, recordId, p.notifyClient, ctx.outboxId);
      const rest = Object.keys(p).filter(k => !['notifyClient', 'servicesVersion', 'version'].includes(k));
      if (!rest.length) return { recordId, prefsOnly: true };
    }
```

`index.js`: вверху добавить `const prefs = require('./record-prefs');`. В `detail`:
- ветка `id < 0`: строку `const out = { ...m.normalizeRecord(r, { withPhone: true }), comment: String(r.comment || '') };` заменить на
```js
    const createStep = (row.steps || []).find(s => s && s.kind === 'create');
    const notify = r.notify_client ?? createStep?.params?.notifyClient ?? true;
    const out = { ...m.normalizeRecord(r, { withPhone: true }), comment: String(r.comment || ''), notifyClient: notify !== false };
```
- в ветке `src.kind === 'local'` строку `const out = { ...m.normalizeRecord(r, { withPhone: true }), comment: String(r.comment || '') };` заменить на
```js
    const pref = r.notify_client ?? (await prefs.get(salonId, id).catch(() => null))?.notify_client ?? true;
    const out = { ...m.normalizeRecord(r, { withPhone: true }), comment: String(r.comment || ''), notifyClient: pref !== false };
```
- последнюю строку функции `return { ...m.normalizeRecord(r, { withPhone: true }), comment: String(r.comment || '') };` заменить на
```js
  const pref = (await prefs.get(salonId, id).catch(() => null))?.notify_client ?? true;
  return { ...m.normalizeRecord(r, { withPhone: true }), comment: String(r.comment || ''), notifyClient: pref !== false };
```

- [ ] **Step 8: Реализация уведомлений**

`backend/services/notifications/events.js`, в `recordSnapshot` после строки `shortLink: d.short_link || '',` добавить:
```js
    // Journal packages send api_id = <числовой id пакета> (journal «не уведомлять», 12.11.2026).
    apiId: typeof d.api_id === 'string' ? d.api_id : '',
```

`backend/services/notifications/enroll.js`:
- после `const salonNames = require('../../utils/salon-names');` добавить `const journalPrefs = require('../journal/record-prefs');`
- после `const CATALOG_REASON = 'каталог услуг YClients недоступен';` добавить
```js
// Журнал записи: администратор снял «уведомлять клиента» (journal_record_prefs / api_id пакета).
const JOURNAL_OPT_OUT_REASON = 'journal_opt_out';
```
- в `enrollEvent` после строки `if (!isActiveMode(cfg)) return;` вставить:
```js
  // Журнал: «не уведомлять клиента» действует на все типы правил по этой записи; флаг могли поставить
  // уже после того, как напоминание встало в очередь — гасим и его. Проверка best-effort (сбой → уведомляем).
  const journalOptOut = await journalPrefs.optOutForEvent(salonId, snap.recordId, snap.apiId);
  if (journalOptOut) await cancelPending(salonId, snap.recordId, JOURNAL_OPT_OUT_REASON);
```
- строку
```js
  const baseSkipReason = !snap.phone ? 'нет телефона клиента'
```
заменить на
```js
  const baseSkipReason = journalOptOut ? JOURNAL_OPT_OUT_REASON : !snap.phone ? 'нет телефона клиента'
```

- [ ] **Step 9: Зелёные + базовая линия + уведомления целиком**

Run: `npx jest backend/journal-outbox-worker backend/journal-service backend/notifications-enroll backend/notifications-events --silent` → PASS.
Run: `npx jest backend/journal service-catalog finance bonus-ledger --silent` → зелёные.
Run: `npx jest backend/notifications backend/webhook-notifications --silent` → зелёные.
Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 5 && pm2 logs loyalpro --lines 60 --nostream | grep -i -E "journal_record_prefs|migrat.*error" | tail`
Expected: пусто (таблица создана без ошибок).

- [ ] **Step 10: Commit**

```bash
cd /root/loyalpro && git add backend/services/journal/record-prefs.js backend/journal-record-prefs.test.js backend/migrations.js backend/services/journal/outbox-worker.js backend/services/journal/index.js backend/services/notifications/events.js backend/services/notifications/enroll.js backend/journal-outbox-worker.test.js backend/journal-service.test.js backend/journal-local-ddl.test.js backend/notifications-enroll.test.js && git commit -m "feat(journal,notifications): «не уведомлять клиента» для записи журнала

journal_record_prefs пишется воркером до PUT и после создания; вебхук
create, опередивший строку, находит флаг по api_id пакета. Модуль
уведомлений ставит job'ы skipped с причиной journal_opt_out и гасит
pending записи. Сбой проверки — уведомление как раньше.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 6: Сервер — `GET /week` и `GET /month`

**Исполнитель:** Sonnet. **Зависимости:** T2 (`labels`).

**Files:**
- Modify: `backend/services/journal/index.js` (вынести построение графиков дня в `staffForDate`, добавить `weekStart`, `week`, экспорт)
- Create: `backend/services/journal/month.js`
- Modify: `backend/routes/journal.js` (два маршрута + `require`)
- Create: `backend/journal-month.test.js`
- Test: `backend/journal-service.test.js`, `backend/journal-routes.test.js`

Контракты (используют задачу 10):
- `GET /api/journal/week?date=YYYY-MM-DD[&staffId=N]` → `{ from, to, staff: {id, name} | null, allStaff: [{id, name}], labels, days: [{ date, working, workRanges, records }] }`. Семь дней с понедельника московской недели, в которую входит `date`. `staffId` не задан → при локальном источнике — первый сотрудник, работающий хоть в один день недели, иначе первый в списке; при живом источнике (кэш холодный) — первый в списке (не делаем 7×N запросов графика в YClients). Записи — только выбранного мастера, тем же `m.recordsForDay`, что у дня.
- `GET /api/journal/month?month=YYYY-MM` → `{ month, days: [{ date, records, workingStaff, density }] }`; `records` — неудалённые записи зеркала `records` по `visit_date`, `workingStaff` — строки `journal_staff_schedule` с `is_working`, `density` = 0, если записей нет; 3, если работающих нет, а записи есть; иначе по доле `records / (workingStaff × 8)`: `< 1/3` → 1, `< 2/3` → 2, иначе 3.

- [ ] **Step 1: Падающие тесты**

Создать `backend/journal-month.test.js`:

```js
'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret' }));
jest.mock('./db', () => ({ db: { any: jest.fn() } }));
const { db } = require('./db');
const month = require('./services/journal/month');
beforeEach(() => jest.clearAllMocks());
test('monthRange validates YYYY-MM and knows the month length', () => {
  expect(month.monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29', days: 29 });
  expect(month.monthRange('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30', days: 30 });
  for (const bad of ['2026-13', '2026-1', '26-11', undefined, '2026-11-01']) expect(() => month.monthRange(bad)).toThrow();
});
test('density: 0 without records, by share of workingStaff × 8, 3 when nobody works', () => {
  expect(month.density(0, 4)).toBe(0);
  expect(month.density(5, 4)).toBe(1);   // 5/32 < 1/3
  expect(month.density(12, 4)).toBe(2);  // 12/32 = 0.375
  expect(month.density(25, 4)).toBe(3);  // 25/32 > 2/3
  expect(month.density(2, 0)).toBe(3);
});
test('monthDays fills every day of the month', () => {
  const days = month.monthDays('2026-11', [{ date: '2026-11-02', n: 12 }], [{ date: '2026-11-02', n: 4 }, { date: '2026-11-03', n: 2 }]);
  expect(days).toHaveLength(30);
  expect(days[1]).toEqual({ date: '2026-11-02', records: 12, workingStaff: 4, density: 2 });
  expect(days[2]).toEqual({ date: '2026-11-03', records: 0, workingStaff: 2, density: 0 });
});
test('month reads the mirror and schedules of THIS salon only, without deleted records', async () => {
  db.any.mockResolvedValueOnce([{ date: '2026-11-02', n: 3 }]).mockResolvedValueOnce([{ date: '2026-11-02', n: 1 }]);
  const out = await month.month(7, '2026-11');
  expect(out.month).toBe('2026-11');
  expect(out.days[1]).toMatchObject({ records: 3, workingStaff: 1, density: 2 });
  const [recSql, recArgs] = db.any.mock.calls[0];
  expect(recSql).toMatch(/FROM records/); expect(recSql).toMatch(/salon_id=\$1/); expect(recSql).toMatch(/'deleted'/);
  expect(recArgs).toEqual([7, '2026-11-01', '2026-11-30']);
  const [staffSql, staffArgs] = db.any.mock.calls[1];
  expect(staffSql).toMatch(/FROM journal_staff_schedule/); expect(staffSql).toMatch(/is_working/);
  expect(staffArgs).toEqual([7, '2026-11-01', '2026-11-30']);
});
```

В блок `describe('parity fields (12.11.2026)', …)` файла `backend/journal-service.test.js`:

```js
  test('weekStart is the Moscow Monday', () => {
    expect(service.weekStart('2030-04-03')).toBe('2030-04-01');
    expect(service.weekStart('2030-04-07')).toBe('2030-04-01');
    expect(service.weekStart('2030-04-01')).toBe('2030-04-01');
  });
  test('week: 7 days of one master built like the day', async () => {
    yc.records.mockResolvedValue([record]);
    const out = await service.week(3, '2030-04-03', null);
    expect(out.from).toBe('2030-04-01'); expect(out.to).toBe('2030-04-07');
    expect(out.staff).toEqual({ id: 1, name: 'Сотрудник' });
    expect(out.allStaff).toEqual([{ id: 1, name: 'Сотрудник' }]);
    expect(out.days.map(d => d.date)).toEqual(['2030-04-01', '2030-04-02', '2030-04-03', '2030-04-04', '2030-04-05', '2030-04-06', '2030-04-07']);
    expect(out.days[0]).toMatchObject({ working: true, workRanges: [{ start: 540, end: 720 }] });
    expect(out.days[0].records.map(r => r.id)).toEqual([8]);
    expect(out.days[1]).toMatchObject({ working: false, records: [] });
    expect(yc.records).toHaveBeenCalledWith(expect.anything(), '2030-03-31', '2030-04-08');
  });
  test('week with an unknown staffId is 404', async () => {
    await expect(service.week(3, '2030-04-03', 99)).rejects.toMatchObject({ status: 404 });
  });
```

В `backend/journal-routes.test.js`: в фабрику мока `./services/journal` добавить `week: jest.fn()`; после строки с `jest.mock('./services/journal', …)` добавить
```js
jest.mock('./services/journal/month', () => ({ month: jest.fn() }));
```
и в конец файла:
```js
test('week and month: validated input, tenant from JWT', async () => {
  const month = require('./services/journal/month');
  service.week.mockResolvedValue({ days: [] }); month.month.mockResolvedValue({ days: [] });
  expect((await call('GET', '/week', { query: { date: '2030-04-01', staffId: '5', salonId: 99 } })).status).toBe(200);
  expect(service.week).toHaveBeenCalledWith(3, '2030-04-01', 5);
  expect((await call('GET', '/week', { query: { date: '2030-04-01' } })).status).toBe(200);
  expect(service.week).toHaveBeenLastCalledWith(3, '2030-04-01', null);
  expect((await call('GET', '/week', { query: { date: 'x' } })).status).toBe(400);
  expect((await call('GET', '/month', { query: { month: '2030-04' } })).status).toBe(200);
  expect(month.month).toHaveBeenCalledWith(3, '2030-04');
  expect((await call('GET', '/week', { user: { role: 'specialist' }, query: { date: '2030-04-01' } })).status).toBe(403);
});
```

- [ ] **Step 2: Запустить — падают**

Run: `cd /root/loyalpro/backend && npx jest backend/journal-month backend/journal-service backend/journal-routes --silent`
Expected: FAIL — `Cannot find module './services/journal/month'`, `service.weekStart is not a function`, `/week` → 404.

- [ ] **Step 3: Реализация `month.js`**

Создать `backend/services/journal/month.js`:

```js
'use strict';
// Month calendar of the journal (spec 2026-11-12 §3.1): records per day from
// the mirror and working staff from the cached schedules — no YClients.
const { db } = require('../../db');
const m = require('./model');

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
// A day is «full» at 8 visits per working master (owner's rule of thumb).
const VISITS_PER_MASTER = 8;

function monthRange(month) {
  if (typeof month !== 'string' || !MONTH.test(month)) m.fail('Укажите месяц в формате ГГГГ-ММ.');
  const [y, mo] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(days).padStart(2, '0')}`, days };
}
function density(records, workingStaff) {
  const n = Number(records) || 0, staff = Number(workingStaff) || 0;
  if (n <= 0) return 0;
  if (staff <= 0) return 3;
  const share = n / (staff * VISITS_PER_MASTER);
  return share < 1 / 3 ? 1 : share < 2 / 3 ? 2 : 3;
}
function monthDays(month, recordRows, staffRows) {
  const { days } = monthRange(month);
  const rec = new Map((recordRows || []).map(r => [String(r.date), Number(r.n) || 0]));
  const st = new Map((staffRows || []).map(r => [String(r.date), Number(r.n) || 0]));
  return Array.from({ length: days }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, '0')}`;
    const records = rec.get(date) || 0, workingStaff = st.get(date) || 0;
    return { date, records, workingStaff, density: density(records, workingStaff) };
  });
}
const RECORDS_SQL = `SELECT to_char(visit_date,'YYYY-MM-DD') AS date, count(*)::int AS n FROM records
  WHERE salon_id=$1 AND visit_date BETWEEN $2::date AND $3::date AND COALESCE(status,'')<>'deleted'
    AND COALESCE(raw_payload->>'deleted','false') NOT IN ('true','1')
  GROUP BY 1`;
const STAFF_SQL = `SELECT to_char(date,'YYYY-MM-DD') AS date, count(*)::int AS n FROM journal_staff_schedule
  WHERE salon_id=$1 AND date BETWEEN $2::date AND $3::date AND is_working
  GROUP BY 1`;
async function month(salonId, monthKey) {
  const r = monthRange(monthKey);
  const [records, staff] = await Promise.all([
    db.any(RECORDS_SQL, [salonId, r.from, r.to]),
    db.any(STAFF_SQL, [salonId, r.from, r.to]),
  ]);
  return { month: monthKey, days: monthDays(monthKey, records, staff) };
}
module.exports = { monthRange, density, monthDays, month, RECORDS_SQL, STAFF_SQL, VISITS_PER_MASTER };
```

- [ ] **Step 4: Реализация `week` в `index.js`**

Перед `async function day(salonId, date, src) {` вставить:

```js
// Schedules of a staff list for one date with bounded concurrency (a burst
// against the shared YClients quota is avoided; cached schedules are local).
async function staffForDate(src, list, date) {
  const staff = new Array(list.length);
  const width = src.kind === 'local' ? list.length : 3;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, list.length) }, async () => {
    while (next < list.length) {
      const index = next++, s = list[index];
      const schedule = await src.schedule(s.id, date);
      staff[index] = { id: Number(s.id), name: String(s.name || 'Сотрудник'), ...m.staffSchedule(schedule, date) };
    }
  }));
  return staff;
}
const weekStart = date => {
  const dow = new Date(date + 'T12:00:00Z').getUTCDay();
  return shiftDate(date, -((dow + 6) % 7));
};
```

В `day` заменить блок от `  // Bounded concurrency avoids a burst …` до закрывающего `  }));` (цикл с `const staff = new Array(data.staff.length);`) на одну строку:
```js
  const staff = await staffForDate(src, data.staff, date);
```

После функции `day` вставить:

```js
// Week view (spec 2026-11-12 §3.1): one master × 7 days from Monday, built
// with the same pieces as the day (staffSchedule + recordsForDay).
async function week(salonId, date, staffId, src) {
  const salon = await salonFor(salonId);
  if (!src) src = await sources.forSalon(salon);
  const from = weekStart(date);
  const dates = Array.from({ length: 7 }, (_, i) => shiftDate(from, i));
  const [staffSource, records, labels] = await Promise.all([src.staff(), src.records(shiftDate(from, -1), shiftDate(from, 7)),
    typeof src.labels === 'function' ? src.labels().catch(() => []) : []]);
  const list = staffSource.filter(s => !s.fired && !m.isAdministrator(s));
  const allStaff = list.map(s => ({ id: Number(s.id), name: String(s.name || 'Сотрудник') }));
  let chosen = staffId ? list.find(s => Number(s.id) === Number(staffId)) : null;
  if (staffId && !chosen) m.fail('Сотрудник недоступен.', 404);
  const schedules = new Map();
  const scheduleOf = async (s, d) => {
    const key = s.id + ':' + d;
    if (!schedules.has(key)) schedules.set(key, await src.schedule(s.id, d));
    return schedules.get(key);
  };
  // Live source = YClients calls: no 7×N scan for «the first working master».
  if (!chosen && src.kind === 'local') {
    outer: for (const s of list) for (const d of dates) if (m.staffSchedule(await scheduleOf(s, d), d).working) { chosen = s; break outer; }
  }
  chosen = chosen || list[0] || null;
  const base = { from, to: dates[6], allStaff, labels: m.normalizeLabels(labels), fetchedAt: new Date().toISOString(),
    freshness: await mirror.freshness(salonId), source: src.kind };
  if (!chosen) return { ...base, staff: null, days: dates.map(d => ({ date: d, working: false, workRanges: [], records: [] })) };
  const id = Number(chosen.id);
  const days = [];
  for (const d of dates) {
    const sched = m.staffSchedule(await scheduleOf(chosen, d), d);
    days.push({ date: d, working: sched.working, workRanges: sched.workRanges,
      records: m.recordsForDay(records, d).filter(r => r.staffId === id) });
  }
  return { ...base, staff: { id, name: String(chosen.name || 'Сотрудник') }, days };
}
```

В `module.exports` добавить `week, weekStart`.

- [ ] **Step 5: Маршруты**

`backend/routes/journal.js`: после `const dispatch = require('../services/journal/dispatch');` добавить
```js
const month = require('../services/journal/month');
```
после строки `router.get('/day', …);` добавить
```js
router.get('/week', handle(req => service.week(req.user.salonId, m.dateKey(req.query.date), req.query.staffId ? m.positiveId(req.query.staffId) : null)));
router.get('/month', handle(req => month.month(req.user.salonId, req.query.month)));
```

- [ ] **Step 6: Зелёные + базовая линия + живой EXPLAIN**

Run: `npx jest backend/journal-month backend/journal-service backend/journal-routes --silent` → PASS.
Run: `npx jest backend/journal service-catalog finance bonus-ledger --silent` → зелёные.
Run (дев-сервер на новом коде, токен — как в `backend/scripts/economics-pay-ui-e2e.js`; проще — проверить SQL самим загрузчиком, правило проекта):
```bash
cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 3 && node -e "
require('dotenv').config();
const { db } = require('./db');
const month = require('./services/journal/month');
(async () => {
  for (const sql of [month.RECORDS_SQL, month.STAFF_SQL]) {
    const plan = await db.any('EXPLAIN ANALYZE ' + sql, [1, '2026-11-01', '2026-11-30']);
    console.log(plan.map(r => r['QUERY PLAN']).filter(l => /Execution Time|Scan/.test(l)).join('\n'));
  }
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });"
```
Expected: обе строки `Execution Time` < 50 ms; ошибок нет.

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro && git add backend/services/journal/index.js backend/services/journal/month.js backend/routes/journal.js backend/journal-month.test.js backend/journal-service.test.js backend/journal-routes.test.js && git commit -m "feat(journal): GET /week (мастер × 7 дней) и GET /month (загрузка дней) без YClients

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 7: Сервер — история изменений записи `GET /records/:id/history`

**Исполнитель:** Sonnet. **Зависимости:** T2 (`m.normColor`, `m.normalizeLabels`).

**Files:**
- Create: `backend/services/journal/history.js`
- Create: `backend/journal-history.test.js`
- Modify: `backend/routes/journal.js`
- Test: `backend/journal-routes.test.js`

Контракт ответа (использует задачу 13): `{ recordId, events: [{ at (ISO), source: 'yclients'|'journal', author, title, changes: [{field, label, from, to}], status?, steps?: [{kind, state}], error? }] }`, по убыванию `at`, не больше 200. Автор вебхука — «YClients» (кто менял в YClients, из данных не следует, спека §4.2), пакета — «LoyalPro: Имя». Телефона и email в ответе нет: `diffRecords` сравнивает только перечисленные поля (клиента не сравнивает), из шагов пакета берутся только `kind` и `state` (в `steps` лежат черновики с телефоном — их наружу НЕЛЬЗЯ). Вебхуки до 04.11.2026 отсутствуют (переезд), список начинается с имеющихся.

Готча производительности: у `webhook_logs` есть только индекс `(salon_id, created_at DESC)`, по `resource_id` индекса нет; спека новых индексов не разрешает. Шаг 6 меряет запрос живым EXPLAIN; если > 300 мс — НЕ добавлять индекс самостоятельно, а записать цифру в отчёт задачи (решение — за владельцем).

- [ ] **Step 1: Падающие тесты**

Создать `backend/journal-history.test.js`:

```js
'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret' }));
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn() } }));
const { db } = require('./db');
const h = require('./services/journal/history');
const base = { id: 8, datetime: '2026-11-12T10:00:00+03:00', staff: { id: 1, name: 'Юлия' }, staff_id: 1, seance_length: 3600, attendance: 0,
  services: [{ id: 7, title: 'Чистка', amount: 1, cost: 3000 }], comment: '', custom_color: '', record_labels: [], paid_full: 0, deleted: false,
  client: { name: 'Анна', phone: '79200255591', email: 'a@b.c' } };
beforeEach(() => jest.clearAllMocks());

describe('diffRecords', () => {
  test('no previous state → no changes (creation)', () => expect(h.diffRecords(null, base)).toEqual([]));
  test('time, master, services, length, status, comment, colour, labels, payment, deletion', () => {
    const next = { ...base, datetime: '2026-11-12T12:30:00+03:00', staff: { id: 2, name: 'Пери' }, staff_id: 2, seance_length: 4500, attendance: 2,
      services: [{ id: 7, title: 'Чистка', amount: 2, cost: 6000 }], comment: 'Позвонить', custom_color: 'F4A0A0',
      record_labels: [{ id: 3, title: 'VIP' }], paid_full: 1, deleted: true };
    expect(h.diffRecords(base, next).map(c => [c.label, c.from, c.to])).toEqual([
      ['Время', '12.11 10:00', '12.11 12:30'], ['Специалист', 'Юлия', 'Пери'], ['Услуги', 'Чистка — 3000 ₽', 'Чистка ×2 — 6000 ₽'],
      ['Длительность', '60 мин', '75 мин'], ['Статус', 'Ожидание', 'Подтвердил'], ['Комментарий', null, 'Позвонить'],
      ['Цвет', null, '#f4a0a0'], ['Метки', null, 'VIP'], ['Оплата', 'не оплачено', 'оплачено'], ['Удалена', 'нет', 'да'],
    ]);
  });
  test('client phone and email never appear', () => {
    const out = h.diffRecords(base, { ...base, client: { name: 'Другая', phone: '79000000000', email: 'x@y.z' } });
    expect(out).toEqual([]);
  });
});

describe('mergeHistory', () => {
  const hook = (at, status, data) => ({ created_at: new Date(at), status, data });
  test('webhooks diffed in order, empty repeats dropped; packages with author and step states; newest first', () => {
    const events = h.mergeHistory([
      hook('2026-11-12T07:00:00Z', 'create', base),
      hook('2026-11-12T07:05:00Z', 'update', base),
      hook('2026-11-12T07:10:00Z', 'update', { ...base, comment: 'Позвонить' }),
    ], [
      { id: 5, user_id: 4, status: 'failed', error_text: 'Время занято', created_at: new Date('2026-11-12T07:07:00Z'),
        steps: [{ kind: 'move', state: 'failed', draftJson: '{"client":{"phone":"79200255591"}}', params: { clientPhone: '79200255591' } }] },
    ], new Map([[4, 'Мария']]));
    expect(events.map(e => [e.source, e.title])).toEqual([
      ['yclients', 'Изменена в YClients'], ['journal', 'перенос — ошибка'], ['yclients', 'Создана в YClients'],
    ]);
    expect(events[0].changes).toEqual([{ field: 'comment', label: 'Комментарий', from: null, to: 'Позвонить' }]);
    expect(events[1]).toMatchObject({ author: 'LoyalPro: Мария', status: 'failed', steps: [{ kind: 'move', state: 'failed' }], error: 'Время занято' });
    expect(JSON.stringify(events)).not.toMatch(/79200255591|a@b\.c/);
  });
  test('cap 200', () => {
    const many = Array.from({ length: 250 }, (_, i) => hook(new Date(Date.UTC(2026, 10, 12, 0, i)).toISOString(), 'update', { ...base, comment: 'c' + i }));
    expect(h.mergeHistory(many, [], new Map())).toHaveLength(200);
  });
});

describe('load', () => {
  test('salon-scoped queries; webhooks by record id as text; packages of the record and of its create', async () => {
    db.any.mockImplementation(async sql => {
      if (/FROM webhook_logs/.test(sql)) return [{ created_at: new Date('2026-11-12T07:00:00Z'), status: 'create', data: base }];
      if (/FROM journal_outbox/.test(sql)) return [{ id: 5, user_id: 4, status: 'done', steps: [{ kind: 'create', state: 'done' }], created_at: new Date('2026-11-12T06:59:00Z') }];
      if (/FROM users/.test(sql)) return [{ id: 4, name: 'Мария' }];
      return [];
    });
    const out = await h.load(3, 8);
    expect(out.recordId).toBe(8);
    expect(out.events.map(e => e.author)).toEqual(['YClients', 'LoyalPro: Мария']);
    const hooks = db.any.mock.calls.find(([sql]) => /FROM webhook_logs/.test(sql));
    expect(hooks[0]).toMatch(/event_type='record'/); expect(hooks[1]).toEqual([3, '8']);
    const outbox = db.any.mock.calls.find(([sql]) => /FROM journal_outbox/.test(sql));
    expect(outbox[1]).toEqual([3, 8, null]);
    expect(db.any.mock.calls.find(([sql]) => /FROM users/.test(sql))[1]).toEqual([3, [4]]);
  });
  test('negative id = unsent new record: its packages; webhooks of the created record once known', async () => {
    db.oneOrNone.mockResolvedValue({ yclients_record_id: '900' });
    db.any.mockResolvedValue([]);
    await h.load(3, -5);
    expect(db.oneOrNone.mock.calls[0][1]).toEqual([3, 5]);
    expect(db.any.mock.calls.find(([sql]) => /FROM journal_outbox/.test(sql))[1]).toEqual([3, 900, 5]);
    expect(db.any.mock.calls.find(([sql]) => /FROM webhook_logs/.test(sql))[1]).toEqual([3, '900']);
    db.oneOrNone.mockResolvedValue(null);
    await expect(h.load(3, -6)).rejects.toMatchObject({ status: 404 });
  });
});
```

В `backend/journal-routes.test.js` после строки `jest.mock('./services/journal/month', …);` добавить
```js
jest.mock('./services/journal/history', () => ({ load: jest.fn() }));
```
и в конец:
```js
test('record history: id validated, tenant from JWT', async () => {
  const history = require('./services/journal/history');
  history.load.mockResolvedValue({ recordId: 8, events: [] });
  expect((await call('GET', '/records/8/history')).status).toBe(200);
  expect(history.load).toHaveBeenCalledWith(3, 8);
  expect((await call('GET', '/records/-4/history')).status).toBe(200);
  expect(history.load).toHaveBeenLastCalledWith(3, -4);
  expect((await call('GET', '/records/abc/history')).status).toBe(400);
});
```

- [ ] **Step 2: Запустить — падают**

Run: `cd /root/loyalpro/backend && npx jest backend/journal-history backend/journal-routes --silent`
Expected: FAIL — `Cannot find module './services/journal/history'`.

- [ ] **Step 3: Реализация**

Создать `backend/services/journal/history.js`:

```js
'use strict';
// History of a journal record (spec 2026-11-12 §4.2): YClients record webhooks
// (diffed one against the previous) merged with our outbox packages. No new
// table. Never returns the client's phone or email: only listed fields are
// compared, and of a package only step kind/state leave this module (steps
// hold drafts with the phone).
const { db } = require('../../db');
const m = require('./model');

const CAP = 200;
const STATUS = { '-1': 'Не пришёл', 0: 'Ожидание', 1: 'Пришёл', 2: 'Подтвердил' };
const STEP = { create: 'создание', move: 'перенос', edit: 'изменение', confirm: 'подтверждение', cancel: 'отмена',
  delete: 'удаление', pay: 'оплата', remove_payment: 'удаление оплаты' };
const PACKAGE = { queued: 'ждёт отправки', running: 'передаётся', done: 'отправлено', failed: 'ошибка', cancelled: 'отменено' };
const TITLE = { create: 'Создана в YClients', update: 'Изменена в YClients', delete: 'Удалена в YClients' };

const when = v => { const p = m.moscowParts(v); return p ? `${p.date.slice(8, 10)}.${p.date.slice(5, 7)} ${p.time}` : null; };
const servicesText = list => (Array.isArray(list) ? list : [])
  .map(s => `${String(s.title || 'Услуга')}${Number(s.amount) > 1 ? ' ×' + Number(s.amount) : ''} — ${Number(s.cost) || 0} ₽`)
  .sort().join('; ') || null;
const labelsText = list => m.normalizeLabels(list).map(l => l.title || '#' + l.id).sort().join(', ') || null;
const FIELDS = [
  ['datetime', 'Время', d => when(d.datetime)],
  ['staff', 'Специалист', d => d.staff?.name ? String(d.staff.name) : (d.staff_id != null ? '#' + Number(d.staff_id) : null)],
  ['services', 'Услуги', d => servicesText(d.services)],
  ['seance_length', 'Длительность', d => Number(d.seance_length) > 0 ? Math.round(Number(d.seance_length) / 60) + ' мин' : null],
  ['attendance', 'Статус', d => STATUS[Number(d.attendance) || 0] || null],
  ['comment', 'Комментарий', d => String(d.comment || '').trim() || null],
  ['custom_color', 'Цвет', d => m.normColor(d.custom_color)],
  ['record_labels', 'Метки', d => labelsText(d.record_labels)],
  ['paid_full', 'Оплата', d => Number(d.paid_full) === 1 ? 'оплачено' : Number(d.paid_amount) > 0 ? 'частично' : 'не оплачено'],
  ['deleted', 'Удалена', d => d.deleted ? 'да' : 'нет'],
];
function diffRecords(prev, next) {
  if (!prev || !next) return [];
  const out = [];
  for (const [field, label, read] of FIELDS) {
    const from = read(prev) ?? null, to = read(next) ?? null;
    if (from !== to) out.push({ field, label, from, to });
  }
  return out;
}
const iso = v => (v instanceof Date ? v : new Date(v)).toISOString();
// webhookRows must be OLDEST FIRST (each is diffed against the previous one).
function mergeHistory(webhookRows, outboxRows, users = new Map()) {
  const events = [];
  let prev = null;
  for (const w of webhookRows || []) {
    const data = w.data && typeof w.data === 'object' ? w.data : null;
    const status = TITLE[w.status] ? w.status : 'update';
    const changes = diffRecords(prev, data);
    if (data) {
      // A repeated/irrelevant update (nothing we show changed) is noise.
      if (!(status === 'update' && prev && !changes.length)) events.push({ at: iso(w.created_at), source: 'yclients', author: 'YClients', title: TITLE[status], changes });
      prev = data;
    }
  }
  for (const o of outboxRows || []) {
    const steps = (Array.isArray(o.steps) ? o.steps : []).map(s => ({ kind: String(s?.kind || ''), state: String(s?.state || '') }));
    const name = users.get(Number(o.user_id));
    events.push({ at: iso(o.created_at), source: 'journal', author: 'LoyalPro' + (name ? ': ' + name : ''),
      title: `${steps.map(s => STEP[s.kind] || s.kind).join(', ') || 'изменения'} — ${PACKAGE[o.status] || String(o.status)}`,
      changes: [], status: String(o.status), steps,
      error: o.status === 'failed' ? String(o.error_text || 'причина неизвестна') : null });
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, CAP);
}
const WEBHOOK_SQL = `SELECT created_at, payload->>'status' AS status, payload->'data' AS data FROM webhook_logs
  WHERE salon_id=$1 AND event_type='record' AND resource_id=$2
  ORDER BY created_at DESC, id DESC LIMIT ${CAP}`;
const OUTBOX_SQL = `SELECT id, user_id, status, steps, error_text, created_at FROM journal_outbox
  WHERE salon_id=$1 AND (yclients_record_id=$2 OR id=$3 OR create_outbox_id=$3)
  ORDER BY id DESC LIMIT ${CAP}`;
const USERS_SQL = 'SELECT id, name FROM users WHERE salon_id=$1 AND id = ANY($2::int[])';
const CREATE_SQL = 'SELECT yclients_record_id FROM journal_outbox WHERE salon_id=$1 AND id=$2';
async function load(salonId, recordId) {
  let ycId = recordId > 0 ? Number(recordId) : null;
  const createId = recordId < 0 ? -Number(recordId) : null;
  if (createId) {
    const row = await db.oneOrNone(CREATE_SQL, [salonId, createId]);
    if (!row) m.fail('Запись не найдена.', 404);
    if (row.yclients_record_id != null) ycId = Number(row.yclients_record_id);
  }
  const [hooks, outbox] = await Promise.all([
    ycId ? db.any(WEBHOOK_SQL, [salonId, String(ycId)]) : Promise.resolve([]),
    db.any(OUTBOX_SQL, [salonId, ycId, createId]),
  ]);
  const ids = [...new Set((outbox || []).map(o => Number(o.user_id)).filter(n => Number.isSafeInteger(n) && n > 0))];
  const users = new Map((ids.length ? await db.any(USERS_SQL, [salonId, ids]) : []).map(u => [Number(u.id), String(u.name || '')]));
  return { recordId, events: mergeHistory([...(hooks || [])].reverse(), outbox, users) };
}
module.exports = { diffRecords, mergeHistory, load, WEBHOOK_SQL, OUTBOX_SQL, CAP };
```

`backend/routes/journal.js`: после `const month = require('../services/journal/month');` добавить `const history = require('../services/journal/history');`; после `router.get('/records/:id', …);` добавить:
```js
router.get('/records/:id/history', handle(req => history.load(req.user.salonId, m.nonZeroId(req.params.id))));
```

- [ ] **Step 4: Зелёные**

Run: `npx jest backend/journal-history backend/journal-routes --silent` → PASS.

Если тест «time, master, …» падает на порядке элементов — порядок задан массивом `FIELDS`, не меняйте ожидание теста.

- [ ] **Step 5: Базовая линия**

Run: `npx jest backend/journal service-catalog finance bonus-ledger --silent` → зелёные.

- [ ] **Step 6: Живой EXPLAIN запроса вебхуков на деве**

```bash
cd /root/loyalpro/backend && node -e "
require('dotenv').config();
const { db } = require('./db');
const h = require('./services/journal/history');
(async () => {
  const any = await db.oneOrNone(\"SELECT salon_id, resource_id FROM webhook_logs WHERE event_type='record' ORDER BY id DESC LIMIT 1\");
  if (!any) { console.log('no record webhooks on dev'); process.exit(0); }
  const plan = await db.any('EXPLAIN ANALYZE ' + h.WEBHOOK_SQL, [any.salon_id, any.resource_id]);
  console.log(plan.map(r => r['QUERY PLAN']).filter(l => /Execution Time|Scan/.test(l)).join('\n'));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });"
```
Expected: строка `Execution Time: … ms`. Записать число в отчёт задачи; > 300 мс — сообщить ревьюеру (индекс не добавлять).

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro && git add backend/services/journal/history.js backend/journal-history.test.js backend/routes/journal.js backend/journal-routes.test.js && git commit -m "feat(journal): история изменений записи — вебхуки YClients и пакеты журнала

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 8: Сервер — панель клиента `GET /clients/summary`

**Исполнитель:** Sonnet. **Зависимости:** нет.

**Files:**
- Create: `backend/services/journal/client-summary.js`
- Create: `backend/journal-client-summary.test.js`
- Modify: `backend/routes/journal.js`
- Test: `backend/journal-routes.test.js`

Контракт (использует задачу 13): `GET /api/journal/clients/summary?phone=…` или `?ycClientId=…` → `{ name, phone, visits: {success, fail}, bonusBalance, loyaltyLevel, totalSpent, lastVisits: [{date, staffName, services: [строки], attendance}] (≤10, по убыванию), abonements: [{title, balance, expires}] | null, bonusesSource: 'ledger'|'card' }`.
- `visits` — из `client.success_visits_count/fail_visits_count` последней записи зеркала, иначе подсчёт по `records` (`attendance` 1 / −1).
- баланс: при `config.BONUS_LEDGER_PRIMARY === true` — `clients.bonus_balance` (наш журнал), иначе показание карты `yclients_card_balance` (если `NULL` — `bonus_balance`).
- абонементы — живой `ycGetClientAbonements(salon, phone)` из `backend/services/yclients.js` (параметр именно `phone`, формат `79XXXXXXXXX`), кэш 60 с по `salon:phone` в памяти процесса, сбой → `null` (сбой НЕ кэшируется), кап кэша 500 ключей.
- все SQL — с `salon_id`; телефон сравнивается по последним 10 цифрам (в `clients.phone` номера лежат в разных формах, напр. `+79200255591`).

- [ ] **Step 1: Падающие тесты**

Создать `backend/journal-client-summary.test.js`:

```js
'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret', BONUS_LEDGER_PRIMARY: false }));
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn() } }));
jest.mock('./services/yclients', () => ({ ycGetClientAbonements: jest.fn() }));
const { db } = require('./db');
const config = require('./config');
const { ycGetClientAbonements } = require('./services/yclients');
const cs = require('./services/journal/client-summary');
const SALON = { id: 3, yclients_company_id: 77 };
const CLIENT = { id: 10, name: 'Анна', phone: '+79200255591', yclients_client_id: 555, bonus_balance: 700, yclients_card_balance: '650.5', loyalty_level: 'Золото', total_spent: '42000' };
const VISIT = { visit_datetime: new Date('2026-11-01T07:00:00Z'), raw_payload: { datetime: '2026-11-01T10:00:00+03:00', staff: { name: 'Юлия' },
  services: [{ title: 'Чистка' }], attendance: 1, client: { success_visits_count: 7, fail_visits_count: 2, phone: '79200255591' } } };
function setup({ client = CLIENT, visits = [VISIT], counts = { success: 4, fail: 1 } } = {}) {
  db.oneOrNone.mockImplementation(async sql => {
    if (/FROM salons/.test(sql)) return SALON;
    if (/FROM clients/.test(sql)) return client;
    if (/count\(\*\)/.test(sql)) return counts;
    return null;
  });
  db.any.mockImplementation(async sql => (/FROM records/.test(sql) ? visits : []));
}
beforeEach(() => { jest.clearAllMocks(); cs._cache.clear(); config.BONUS_LEDGER_PRIMARY = false; setup();
  ycGetClientAbonements.mockResolvedValue([{ type: { title: 'Чистка ×5' }, balance_container: { links: [{ count: 3 }] }, expiration_date: '2027-01-01' }]); });

test('summary by phone: card, counts from the mirror, last visits, abonements', async () => {
  const out = await cs.summary(3, { phone: '8 920 025-55-91' });
  expect(out).toEqual({ name: 'Анна', phone: '79200255591', visits: { success: 7, fail: 2 }, bonusBalance: 650.5, loyaltyLevel: 'Золото', totalSpent: 42000,
    lastVisits: [{ date: '2026-11-01', staffName: 'Юлия', services: ['Чистка'], attendance: 1 }],
    abonements: [{ title: 'Чистка ×5', balance: 3, expires: '2027-01-01' }], bonusesSource: 'card' });
  expect(ycGetClientAbonements).toHaveBeenCalledWith(SALON, '79200255591');
  for (const [sql, args] of [...db.oneOrNone.mock.calls, ...db.any.mock.calls]) if (!/FROM salons/.test(sql)) expect(args[0]).toBe(3);
});
test('ledger mode shows our balance', async () => {
  config.BONUS_LEDGER_PRIMARY = true;
  const out = await cs.summary(3, { ycClientId: '555' });
  expect(out).toMatchObject({ bonusBalance: 700, bonusesSource: 'ledger' });
});
test('without counters in the mirror, visits are counted', async () => {
  setup({ visits: [{ ...VISIT, raw_payload: { ...VISIT.raw_payload, client: {} } }] });
  expect((await cs.summary(3, { phone: '79200255591' })).visits).toEqual({ success: 4, fail: 1 });
});
test('abonements: cached 60 s, failure → null and not cached', async () => {
  await cs.summary(3, { phone: '79200255591' }); await cs.summary(3, { phone: '79200255591' });
  expect(ycGetClientAbonements).toHaveBeenCalledTimes(1);
  cs._cache.clear(); ycGetClientAbonements.mockRejectedValueOnce(new Error('boom'));
  expect((await cs.summary(3, { phone: '79200255591' })).abonements).toBe(null);
  expect((await cs.summary(3, { phone: '79200255591' })).abonements).toHaveLength(1);
});
test('unknown client still answers; bad input is 400', async () => {
  setup({ client: null, visits: [] });
  expect(await cs.summary(3, { phone: '79200255591' })).toMatchObject({ name: null, bonusBalance: null, totalSpent: null, lastVisits: [] });
  await expect(cs.summary(3, {})).rejects.toMatchObject({ status: 400 });
  await expect(cs.summary(3, { phone: '123' })).rejects.toMatchObject({ status: 400 });
  await expect(cs.summary(3, { ycClientId: 'x' })).rejects.toMatchObject({ status: 400 });
});
```

В `backend/journal-routes.test.js` после строки `jest.mock('./services/journal/history', …);` добавить
```js
jest.mock('./services/journal/client-summary', () => ({ summary: jest.fn() }));
```
и в конец:
```js
test('client summary: tenant from JWT, query passed as is (validated in the module)', async () => {
  const cs = require('./services/journal/client-summary');
  cs.summary.mockResolvedValue({ name: 'A' });
  const res = await call('GET', '/clients/summary', { query: { phone: '79200255591', salonId: 99 } });
  expect(res.status).toBe(200); expect(res.headers['Cache-Control']).toBe('no-store');
  expect(cs.summary).toHaveBeenCalledWith(3, expect.objectContaining({ phone: '79200255591' }));
  expect((await call('GET', '/clients/summary', { user: { role: 'admin_cashier' }, query: { phone: '79200255591' } })).status).toBe(403);
});
```

- [ ] **Step 2: Запустить — падают**

Run: `cd /root/loyalpro/backend && npx jest backend/journal-client-summary backend/journal-routes --silent`
Expected: FAIL — `Cannot find module './services/journal/client-summary'`.

- [ ] **Step 3: Реализация**

Создать `backend/services/journal/client-summary.js`:

```js
'use strict';
// Client panel of the journal card (spec 2026-11-12 §4.4). Local data only,
// except abonements (live YClients, cached 60 s per salon+phone; a failure is
// null and is not cached). The router lets only owner/admin read it.
const { db } = require('../../db');
const config = require('../../config');
const m = require('./model');
const { ycGetClientAbonements } = require('../yclients');

const TTL_MS = 60000;
const CACHE_MAX = 500;
const cache = new Map();

function canonPhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  return /^\d{10,15}$/.test(d) ? d : null;
}
const countOf = v => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
// Visits left: united balance → united_balance_services_count, else sum of links (as get-client-abonements).
function abonementsView(list) {
  return (Array.isArray(list) ? list : []).map(a => {
    const links = Array.isArray(a?.balance_container?.links) ? a.balance_container.links : [];
    const balance = a?.is_united_balance_unlimited ? 'безлимит'
      : a?.is_united_balance ? Number(a.united_balance_services_count) || 0
      : links.reduce((s, l) => s + (Number(l.count) || 0), 0);
    return { title: String(a?.type?.title || a?.balance_string || 'Абонемент'), balance, expires: a?.expiration_date || null };
  });
}
async function abonements(salon, phone, now = Date.now()) {
  const key = salon.id + ':' + phone;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  let value = null;
  try { value = abonementsView(await ycGetClientAbonements(salon, phone)); } catch (_) { value = null; }
  if (value !== null) {
    cache.set(key, { at: now, value });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return value;
}
const WHO = `(($2::bigint IS NOT NULL AND yclients_client_id=$2)
  OR ($3::text IS NOT NULL AND right(regexp_replace(COALESCE(%PHONE%,''),'\\D','','g'),10)=right($3,10)))`;
const CLIENT_SQL = `SELECT id, name, phone, yclients_client_id, bonus_balance, yclients_card_balance, loyalty_level, total_spent
  FROM clients WHERE salon_id=$1 AND ${WHO.replace('%PHONE%', 'phone')}
  ORDER BY (yclients_client_id IS NOT DISTINCT FROM $2) DESC, id LIMIT 1`;
const RECORD_WHO = WHO.replace('%PHONE%', "raw_payload->'client'->>'phone'");
const VISITS_SQL = `SELECT visit_datetime, raw_payload FROM records WHERE salon_id=$1 AND ${RECORD_WHO}
  AND COALESCE(status,'')<>'deleted' AND COALESCE(raw_payload->>'deleted','false') NOT IN ('true','1') AND visit_datetime <= NOW()
  ORDER BY visit_datetime DESC LIMIT 10`;
const COUNTS_SQL = `SELECT count(*) FILTER (WHERE raw_payload->>'attendance'='1')::int AS success,
  count(*) FILTER (WHERE raw_payload->>'attendance'='-1')::int AS fail
  FROM records WHERE salon_id=$1 AND ${RECORD_WHO} AND COALESCE(status,'')<>'deleted'`;

async function summary(salonId, query = {}) {
  const phone = query.phone != null && query.phone !== '' ? canonPhone(query.phone) : null;
  if (query.phone != null && query.phone !== '' && !phone) m.fail('Некорректный телефон.');
  const ycClientId = query.ycClientId != null && query.ycClientId !== '' ? m.positiveId(query.ycClientId) : null;
  if (!phone && !ycClientId) m.fail('Укажите телефон или клиента.');
  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id=$1', [salonId]);
  if (!salon) m.fail('Салон не найден.', 404);
  const client = await db.oneOrNone(CLIENT_SQL, [salonId, ycClientId, phone]);
  const yc = ycClientId || (client?.yclients_client_id != null ? Number(client.yclients_client_id) : null);
  const ph = phone || canonPhone(client?.phone);
  const rows = await db.any(VISITS_SQL, [salonId, yc, ph]);
  const last = rows[0]?.raw_payload?.client || {};
  let visits = { success: countOf(last.success_visits_count), fail: countOf(last.fail_visits_count) };
  if (visits.success === null || visits.fail === null) {
    const c = await db.oneOrNone(COUNTS_SQL, [salonId, yc, ph]);
    visits = { success: visits.success ?? (Number(c?.success) || 0), fail: visits.fail ?? (Number(c?.fail) || 0) };
  }
  const ledger = config.BONUS_LEDGER_PRIMARY === true;
  const bonusBalance = !client ? null : ledger ? Number(client.bonus_balance) || 0
    : client.yclients_card_balance != null ? Number(client.yclients_card_balance) : Number(client.bonus_balance) || 0;
  return {
    name: client?.name || rows[0]?.raw_payload?.client?.name || null,
    phone: ph,
    visits, bonusBalance,
    loyaltyLevel: client?.loyalty_level || null,
    totalSpent: client ? Number(client.total_spent) || 0 : null,
    lastVisits: rows.map(v => {
      const p = v.raw_payload || {};
      const at = m.moscowParts(p.datetime || (v.visit_datetime instanceof Date ? v.visit_datetime.toISOString() : v.visit_datetime));
      return { date: at?.date || null, staffName: String(p.staff?.name || ''),
        services: (Array.isArray(p.services) ? p.services : []).map(s => String(s?.title || '')).filter(Boolean),
        attendance: Number(p.attendance) || 0 };
    }),
    abonements: ph && salon.yclients_company_id ? await abonements(salon, ph) : null,
    bonusesSource: ledger ? 'ledger' : 'card',
  };
}
module.exports = { summary, canonPhone, abonementsView, _cache: cache, CLIENT_SQL, VISITS_SQL, COUNTS_SQL };
```

Готча экранирования: в шаблонной строке JS `'\\D'` даёт в SQL `'\D'` — это регэксп «не цифра» (при `standard_conforming_strings=on`, по умолчанию). Не превращайте в `'\D'` в JS-исходнике: JS съест обратную косую.

`backend/routes/journal.js`: после `const history = require('../services/journal/history');` добавить `const clientSummary = require('../services/journal/client-summary');`, после маршрута истории добавить:
```js
router.get('/clients/summary', handle(req => clientSummary.summary(req.user.salonId, req.query)));
```

- [ ] **Step 4: Зелёные + базовая линия + живой прогон SQL**

Run: `npx jest backend/journal-client-summary backend/journal-routes --silent` → PASS.
Run: `npx jest backend/journal service-catalog finance bonus-ledger --silent` → зелёные.
Run (проверка SQL самим загрузчиком на дев-БД, без YClients — абонементы тут будут живым вызовом, это одно чтение):
```bash
cd /root/loyalpro/backend && node -e "
require('dotenv').config();
const cs = require('./services/journal/client-summary');
cs.summary(1, { phone: '79200255591' }).then(s => { console.log(JSON.stringify({ ...s, phone: s.phone ? 'ok' : null, name: s.name ? 'ok' : null }, null, 1)); process.exit(0); })
  .catch(e => { console.error('FAIL', e.message); process.exit(1); });"
```
Expected: JSON без ошибок SQL; `lastVisits` — массив, `visits` — числа.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/journal/client-summary.js backend/journal-client-summary.test.js backend/routes/journal.js backend/journal-routes.test.js && git commit -m "feat(journal): панель клиента — визиты, неявки, бонусы, абонементы, последние визиты

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 9: Сетка — цвет и метки записи, значки, перерывы, печать

**Исполнитель:** Sonnet. **Зависимости:** T1 (файлы), T2 (поля записи, `labels` в ответе дня).

**Files:**
- Modify: `frontend/js/pages/journal-grid.js` (`jrCellState`, `jrRender` — целиком; новые `jrOccupied`, `JR_HEX`, `jrContrastColor`, `jrVisitStyle`, `jrLabelOf`, `jrVisitMarks`, `jrBounds`, `jrColumnHtml`)
- Modify: `frontend/css/journal.css` (дописать в конец)
- Modify: `frontend/index.html` (тулбар журнала, бамп `?v=` у `journal-grid.js` и `journal.css`)
- Test: `backend/journal-ui.test.js`

Контракт функций (используют задачи 10, 11): `jrColumnHtml(staff, date, records, allRecords, start, end, now)` возвращает HTML одной колонки `<div class="jr-column" data-staff data-date>…</div>`; `jrBounds(records, ranges)` → `{start, end}` в минутах; `jrOccupied(r)` — минуты, занятые записью вместе с техническим перерывом; `JR_HEX` — регэксп `#rrggbb`.

Готча: существующий тест `quarter cells respect breaks, past time and appointments hidden by search` ожидает `'off'` для минуты 600 при интервалах смены 540–600 и 660–720. По спеке §3.2 это ПЕРЕРЫВ — ожидание меняется на `'break'` (шаг 1).

- [ ] **Step 1: Падающие тесты**

В `backend/journal-ui.test.js` в тесте `quarter cells respect breaks, past time and appointments hidden by search` строку
```js
  expect(h.context.jrCellState(staff,600,'2030-04-01',[],0)).toBe('off');
```
заменить на
```js
  expect(h.context.jrCellState(staff,600,'2030-04-01',[],0)).toBe('break');
  expect(h.context.jrCellState(staff,720,'2030-04-01',[],0)).toBe('off');
  expect(h.context.jrCellState(staff,525,'2030-04-01',[],0)).toBe('off');
```

В конец файла добавить:

```js
// ---- Parity grid (12.11.2026) ----
const PARITY_DAY = `journal.data = {date:'2030-04-01',labels:[{id:3,title:'<b>VIP</b>',color:'#ff0000'}],
  staff:[{id:1,name:'Test',working:true,workRanges:[{start:540,end:660},{start:720,end:840}]}],
  records:[{id:8,staffId:1,date:'2030-04-01',time:'09:30',duration:60,clientName:'Анна',attendance:0,services:[{title:'Чистка'}],
    customColor:'#f4a0a0',fontColor:null,labels:[{id:3,title:'',color:''}],online:true,isNew:true,paidFull:false,comment:'Позвонить',technicalBreak:900}]}`;
test('visit block: custom colour wins, contrast text, label dots resolved from the salon list and escaped', () => {
  const h = harness(); h.run(PARITY_DAY + ';jrRender()');
  const html = h.get('jrGrid').innerHTML;
  expect(html).toContain('--jr-yc:#f4a0a0;--jr-yc-bd:#f4a0a0;color:#333');
  expect(html).toContain('class="jr-label-dot" style="background:#ff0000" title="&lt;b&gt;VIP&lt;/b&gt;"');
  expect(html).not.toContain('<b>VIP</b>');
  for (const t of ['Онлайн-запись', 'Новый клиент', 'Есть комментарий']) expect(html).toContain(`title="${t}"`);
  expect(html).not.toContain('title="Оплачено"');
});
test('technical break band under the visit; the break time is busy', () => {
  const h = harness(); h.run(PARITY_DAY + ';jrRender()');
  const html = h.get('jrGrid').innerHTML;
  expect(html).toMatch(/class="jr-break-band"[^>]*title="Технический перерыв 15 мин"/);
  expect(html).not.toContain('data-time="10:30"');   // 09:30 + 60 + 15 → 10:45
  expect(html).toContain('data-time="10:45"');
});
test('break between two shift intervals is its own cell with a label once', () => {
  const h = harness(); h.run(PARITY_DAY + ';jrRender()');
  const html = h.get('jrGrid').innerHTML;
  expect((html.match(/jr-cell-break/g) || []).length).toBe(4);   // 11:00–12:00 = 4 quarters
  expect((html.match(/>Перерыв</g) || []).length).toBe(1);
});
test('custom colours only as #rrggbb; an injected colour is ignored', () => {
  const h = harness();
  expect(h.context.jrVisitStyle({ customColor: 'red;background:url(x)' })).toBe('');
  expect(h.context.jrVisitStyle({ customColor: '#000000' })).toBe('--jr-yc:#000000;--jr-yc-bd:#000000;color:#fff;');
  expect(h.context.jrVisitStyle({ customColor: '#ffffff', fontColor: '#123456' })).toBe('--jr-yc:#ffffff;--jr-yc-bd:#ffffff;color:#123456;');
  expect(h.context.jrContrastColor('#f7c76d')).toBe('#333');
});
test('columns carry staff and date for drag-and-drop', () => {
  const h = harness(); h.run(PARITY_DAY + ';jrRender()');
  expect(h.get('jrGrid').innerHTML).toContain('<div class="jr-column" data-staff="1" data-date="2030-04-01">');
});
test('print: toolbar button and print stylesheet keep colours', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  expect(html).toContain('id="jrPrint"');
  const css = fs.readFileSync(path.join(__dirname, '../frontend/css/journal.css'), 'utf8');
  expect(css).toMatch(/@media print\{[^]*print-color-adjust:exact/);
  expect(css).toContain('.jr-cell-break');
});
```

- [ ] **Step 2: Запустить — падают**

Run: `cd /root/loyalpro/backend && npx jest backend/journal-ui --silent`
Expected: FAIL — `'off'` вместо `'break'`, нет `--jr-yc:#f4a0a0`, `jrVisitStyle is not a function`, нет `id="jrPrint"`.

- [ ] **Step 3: Реализация в `journal-grid.js`**

Заменить функцию `jrCellState` целиком на:

```js
// Minutes a visit occupies on the grid: its length plus the technical break.
const jrOccupied = r => (r.duration > 0 ? r.duration : 15) + (Number(r.technicalBreak) > 0 ? Number(r.technicalBreak) / 60 : 0);
function jrCellState(staff, minute, date, records, now = Date.now()) {
  const ranges = staff.workRanges || [];
  if (!ranges.some(r => minute >= r.start && minute + 15 <= r.end)) {
    // Between two intervals of one shift = the master's break, not «off» (spec §3.2).
    return ranges.some(r => r.end <= minute) && ranges.some(r => r.start >= minute + 15) ? 'break' : 'off';
  }
  if (Date.parse(date + 'T00:00:00+03:00') + minute * 60000 <= now) return 'past';
  // Use ALL appointments, including those hidden by a search filter.
  if (records.some(r => r.staffId === staff.id && !r.deleted && r.time &&
    minute < jrMinutes(r.time) + jrOccupied(r) && minute + 15 > jrMinutes(r.time))) return 'busy';
  return 'free';
}
```

Заменить функцию `jrRender` целиком на следующий блок (новые помощники + `jrRender`):

```js
// Record colour (spec §3.2): custom_color wins over the status colour; text is
// custom_font_color or an automatic contrast. Only #rrggbb ever reaches style=.
const JR_HEX = /^#[0-9a-f]{6}$/i;
function jrContrastColor(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#333';
  const n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#333' : '#fff';
}
function jrVisitStyle(r) {
  if (!JR_HEX.test(r.customColor || '')) return '';
  const font = JR_HEX.test(r.fontColor || '') ? r.fontColor : jrContrastColor(r.customColor);
  return `--jr-yc:${r.customColor};--jr-yc-bd:${r.customColor};color:${font};`;
}
// A label from our own overlay is a bare id: title/colour come from the salon list.
function jrLabelOf(l) {
  const known = (journal.data?.labels || []).find(x => Number(x.id) === Number(l.id)) || {};
  const color = JR_HEX.test(l.color || '') ? l.color : JR_HEX.test(known.color || '') ? known.color : '#999999';
  return { id: l.id, title: l.title || known.title || 'Метка', color };
}
function jrVisitMarks(r) {
  const dots = (r.labels || []).map(jrLabelOf).map(l => `<i class="jr-label-dot" style="background:${l.color}" title="${jrEscape(l.title)}"></i>`).join('');
  const icons = [r.online && ['🌐', 'Онлайн-запись'], r.isNew && ['✦', 'Новый клиент'], r.paidFull && ['💳', 'Оплачено'],
    String(r.comment || '').trim() && ['💬', 'Есть комментарий']].filter(Boolean)
    .map(([icon, title]) => `<span class="jr-mark" title="${title}" aria-label="${title}">${icon}</span>`).join('');
  return dots || icons ? `<span class="jr-marks">${dots}${icons}</span>` : '';
}
// Grid bounds in minutes: at least 08:00–21:00, widened by shifts and visits.
function jrBounds(records, ranges) {
  const timed = records.filter(r => r.time);
  const start = Math.max(0, Math.min(8 * 60, ...timed.map(r => Math.floor(jrMinutes(r.time) / 60) * 60), ...ranges.map(r => Math.floor(r.start / 60) * 60)));
  const end = Math.min(1440, Math.max(21 * 60, ...timed.map(r => Math.ceil((jrMinutes(r.time) + jrOccupied(r)) / 60) * 60), ...ranges.map(r => Math.ceil(r.end / 60) * 60)));
  return { start, end };
}
// One column (a master in the day view, a date in the week view).
function jrColumnHtml(s, date, records, allRecords, start, end, now) {
  let cells = '', prev = null;
  for (let t = start; t < end; t += 15) {
    const state = jrCellState(s, t, date, allRecords, now), time = jrTimeLabel(t);
    const position = `top:${(t - start) * JR_PX_PER_MIN}px;height:${15 * JR_PX_PER_MIN}px`;
    const classes = `jr-cell jr-cell-${state}${t % 60 === 0 ? ' jr-cell-hour' : ''}`;
    cells += state === 'free'
      ? `<button type="button" class="${classes}" data-staff="${s.id}" data-date="${date}" data-time="${time}" style="${position}" aria-label="${jrEscape(time + ' — новая запись, ' + (s.name || ''))}"><span>${time} Новый сеанс</span></button>`
      : `<div class="${classes}" style="${position}" aria-hidden="true">${state === 'break' && prev !== 'break' ? '<span>Перерыв</span>' : ''}</div>`;
    prev = state;
  }
  const visits = jrLayout(records).map(r => {
    const length = Math.min(Math.max(r.duration || 15, 5), end - r.start);
    const syncing = jrSyncing(r), failed = r.sync?.status === 'failed', unsent = jrUnsent(r);
    const title = r.time + ' · ' + r.clientName + ' · ' + r.services.map(x => x.title).join(', ') + (failed ? ' · Не передано в YClients: ' + (r.sync.errorText || 'причина неизвестна') : syncing ? ' · передаётся в YClients' : unsent ? ' · не отправлено в YClients' : '');
    const pos = `left:calc(${r.lane * 100 / r.lanes}% + 3px);width:calc(${100 / r.lanes}% - 6px)`;
    const pause = Number(r.technicalBreak) > 0 && !r.continued ? Math.min(Number(r.technicalBreak) / 60, end - r.start - length) : 0;
    const band = pause > 0 ? `<div class="jr-break-band" style="top:${(r.start + length - start) * JR_PX_PER_MIN}px;height:${Math.max(4, pause * JR_PX_PER_MIN - 2)}px;${pos}" title="Технический перерыв ${Math.round(pause)} мин" aria-hidden="true">⏸</div>` : '';
    return `<button type="button" class="jr-visit jr-status-${r.attendance}${r.paidFull ? ' jr-paid-full' : ''}${length < 30 ? ' jr-visit-short' : ''}${syncing ? ' jr-visit-syncing' : ''}${unsent ? ' jr-visit-unsent' : ''}${failed ? ' jr-visit-failed' : ''}" data-record="${r.id}" style="${jrVisitStyle(r)}top:${(r.start - start) * JR_PX_PER_MIN}px;height:${Math.max(6, length * JR_PX_PER_MIN - 2)}px;${pos}" title="${jrEscape(title)}" aria-label="${jrEscape(r.time + ' ' + r.clientName + ', ' + jrStatus(r) + (failed ? ', не передано в YClients' : syncing ? ', передаётся в YClients' : unsent ? ', не отправлено в YClients' : ''))}"><b>${syncing ? '⏳ ' : ''}${jrEscape(r.time)} · ${jrEscape(r.clientName)}${jrVisitMarks(r)}</b><span>${jrEscape(r.services.map(x => x.title).join(', ') || 'Без услуг')}</span><small>${r.continued ? 'Продолжение · ' : ''}${jrEscape(jrStatus(r))}${r.paid ? ' · оплачено' : ''}</small>${failed ? '<small class="jr-sync-failed-note">Не передано в YClients</small>' : unsent ? '<small class="jr-sync-unsent-note">Не отправлено в YClients</small>' : ''}</button>${band}`;
  }).join('');
  return `<div class="jr-column" data-staff="${s.id}" data-date="${date}">${cells}${visits}</div>`;
}
function jrHourLabels(start, end) {
  let labels = '';
  for (let t = start; t < end; t += 15) labels += `<span class="${t % 60 ? 'jr-quarter' : 'jr-hour'}" style="top:${(t - start) * JR_PX_PER_MIN}px">${t % 60 ? String(t % 60).padStart(2, '0') : jrTimeLabel(t)}</span>`;
  return labels;
}
function jrBindGrid(grid) {
  grid.querySelectorAll('[data-record]').forEach(el => el.addEventListener('click', () => jrOpen(Number(el.dataset.record))));
  grid.querySelectorAll('[data-time]').forEach(el => el.addEventListener('click', () => jrGridCreate(Number(el.dataset.staff), el.dataset.time, el.dataset.date)));
}
function jrRender() {
  if (!journal.data) return;
  const filter = jrEl('jrStaffFilter').value;
  const staff = jrStaffList().filter(s => !filter || String(s.id) === filter);
  const query = jrEl('jrSearch').value.trim().toLowerCase();
  const allRecords = journal.data.records;
  const records = allRecords.filter(r => staff.some(s => s.id === r.staffId) && (!query || [r.clientName, ...r.services.map(s => s.title)].join(' ').toLowerCase().includes(query)));
  const grid = jrEl('jrGrid');
  if (!staff.length) { grid.innerHTML = `<p class="jr-empty">${jrEl('jrWorkingOnly').checked ? 'На выбранную дату нет работающих специалистов. Снимите фильтр «Только работающие», чтобы увидеть остальных.' : 'Специалистов пока нет.'}</p>`; return; }
  const { start, end } = jrBounds(records, staff.flatMap(s => s.workRanges || []));
  const height = (end - start) * JR_PX_PER_MIN;
  const now = Date.now();
  grid.innerHTML = `<div class="jr-calendar" data-start="${start}" style="--jr-columns:${staff.length};--jr-height:${height}px"><div class="jr-corner">Время</div>${staff.map(s => `<div class="jr-heading">${jrEscape(s.name)}<small>${s.working ? (s.workRanges || []).map(r => jrTimeLabel(r.start) + '–' + jrTimeLabel(r.end)).join(', ') || 'Рабочий день' : 'Выходной'} · ${records.filter(r => r.staffId === s.id).length} записей</small></div>`).join('')}<div class="jr-hours">${jrHourLabels(start, end)}</div>${staff.map(s => jrColumnHtml(s, journal.data.date, records.filter(r => r.staffId === s.id), allRecords, start, end, now)).join('')}</div>`;
  jrBindGrid(grid);
  if (!records.length && query) grid.insertAdjacentHTML('afterbegin', '<p class="jr-empty">Записей по запросу не найдено. Занятые интервалы остаются недоступны.</p>');
}
```

Заменить функцию `jrGridCreate` на (третий параметр — дата ячейки; в виде «День» он равен дате дня, поэтому поведение прежнее):

```js
function jrGridCreate(staffId, time, date) {
  const staff = jrStaffList().find(s => s.id === staffId);
  if (!staff || !journal.data || jrCellState(staff, jrMinutes(time), journal.data.date, journal.data.records) !== 'free') return;
  jrForm(null, { staffId, time, date: journal.data.date });
}
```

Готча: прежний тест `rendering escapes all patient and catalog text` строит запись без `labels`/`comment` — `jrVisitMarks` обязан это переносить (переносит: `r.labels || []`, `String(r.comment || '')`).

- [ ] **Step 4: CSS**

В конец `frontend/css/journal.css` добавить:

```css
/* Parity with YClients (12.11.2026): breaks, colour, labels, marks, technical break, print. */
.jr-cell-break{background:repeating-linear-gradient(45deg,var(--bg) 0,var(--bg) 3px,transparent 3px,transparent 9px);color:var(--t3)}
.jr-cell-break span{display:block;font-size:10px;padding:2px 0 0 4px;white-space:nowrap}
.jr-marks{display:inline-flex;gap:3px;align-items:center;margin-left:5px;vertical-align:middle}
.jr-mark{font-size:11px;line-height:1;font-weight:400}
.jr-label-dot{display:inline-block;width:8px;height:8px;border-radius:50%;border:1px solid rgba(0,0,0,.25);flex:0 0 8px}
.jr-break-band{position:absolute;z-index:1;border:1px dashed var(--t3);border-radius:4px;background:repeating-linear-gradient(135deg,var(--bg) 0,var(--bg) 4px,var(--card) 4px,var(--card) 8px);font-size:10px;line-height:1;color:var(--t2);text-align:center;overflow:hidden;pointer-events:none}
@media print{
  .topbar,.mnav-drawer,.jr-toolbar,#jrReview,#jrState,#jrStaffChips,#jrMonth{display:none!important}
  .jr-scroll{max-height:none;overflow:visible;border:0}
  .jr-calendar{min-width:0;grid-template-columns:44px repeat(var(--jr-columns),minmax(0,1fr))}
  .jr-heading,.jr-corner{position:static}
  .jr-hours{position:relative}
  #app{display:block!important;height:auto!important;overflow:visible!important}
  #app::before,#app::after{display:none}
  .content{overflow:visible;padding:0}
  .jr-visit,.jr-break-band,.jr-cell-break,.jr-label-dot{print-color-adjust:exact;-webkit-print-color-adjust:exact}
}
```

- [ ] **Step 5: Тулбар и кэш**

В `frontend/index.html` в тулбаре журнала строку
```html
        <button class="btn btn-sec" onclick="loadJournal()">Обновить</button>
```
заменить на
```html
        <button class="btn btn-sec" onclick="loadJournal()">Обновить</button>
        <button class="btn btn-sec" id="jrPrint" onclick="window.print()" title="Печать журнала дня">Печать</button>
```
Бамп: `js/pages/journal-grid.js?v=split-2026-11-12` → `?v=t9-2026-11-12`; `css/journal.css?v=2026-11-12bill` → `css/journal.css?v=t9-2026-11-12`.

- [ ] **Step 6: Зелёные**

Run: `npx jest backend/journal-ui --silent` → PASS (82 теста).
Run: `npx jest backend/journal service-catalog finance bonus-ledger --silent` → зелёные.

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro && git add frontend/js/pages/journal-grid.js frontend/css/journal.css frontend/index.html backend/journal-ui.test.js && git commit -m "feat(journal): цвет и метки записи, значки, технический перерыв, перерывы мастера, печать дня

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 10: Сетка — вид «Неделя», календарь месяца, мобильный день

**Исполнитель:** Sonnet. **Зависимости:** T6 (`/week`, `/month`), T9 (`jrColumnHtml`, `jrBounds`, `jrHourLabels`, `jrBindGrid`).

**Files:**
- Modify: `frontend/js/pages/journal.js` (состояние `journal.view`, `JR_MOBILE_MAX`, `jrIsMobile`, `jrSetView`, `jrStaffChanged`, `loadJournal`, `jrShift`)
- Modify: `frontend/js/pages/journal-grid.js` (`jrGridCreate`, `jrRender`; новые `JR_WEEKDAYS`, `jrRenderWeek`, `jrRenderChips`, `jrMonthCells`, `jrMonthAdd`, `jrMonthPicker`, обработчик `resize`)
- Modify: `frontend/css/journal.css`, `frontend/index.html`
- Test: `backend/journal-ui.test.js`

Правила:
- Неделя загружается ВМЕСТЕ с днём (`Promise.all`): день нужен формам (услуги, категории, список мастеров), неделя — сетке. Данные недели — в `journal.week`, дня — по-прежнему в `journal.data`.
- В неделе ← / → сдвигают на 7 дней; смена мастера в фильтре перезагружает неделю.
- Порог 700px продублирован: `JR_MOBILE_MAX = 700` в `journal.js` и `@media (max-width:700px)` в `journal.css` — менять только вместе (как `CHAT_MOBILE_MAX`). На телефоне неделя не предлагается (кнопка скрыта CSS, `jrSetView('week')` и `loadJournal` переводят вид в «День»), показывается один мастер и чипы для переключения.
- Плотность точек приходит с сервера (`density` 0–3), фронт её не считает.

- [ ] **Step 1: Падающие тесты**

В конец `backend/journal-ui.test.js`:

```js
const WEEK = { from: '2030-04-01', to: '2030-04-07', staff: { id: 1, name: 'Юлия' }, allStaff: [{ id: 1, name: 'Юлия' }], labels: [],
  days: ['01', '02', '03', '04', '05', '06', '07'].map((d, i) => ({ date: `2030-04-${d}`, working: i === 0, workRanges: i === 0 ? [{ start: 540, end: 720 }] : [],
    records: i === 0 ? [{ id: 8, staffId: 1, date: '2030-04-01', time: '10:00', duration: 60, clientName: 'Анна', attendance: 0, services: [] }] : [] })) };
const DAY = { date: '2030-04-03', fetchedAt: '2030-04-03T06:00:00Z', staff: [{ id: 1, name: 'Юлия', working: true, workRanges: [] }], records: [], services: [], categories: [], labels: [] };
test('week view loads day and week together and renders 7 date columns of one master', async () => {
  const h = harness(); h.get('jrDate').value = '2030-04-03';
  h.context.jrApi = jest.fn(async p => (p.startsWith('week') ? WEEK : DAY));
  h.context.jrUpdateDispatchButton = jest.fn();   // harness nodes have no classList
  h.run(`journal.view = 'week'`);
  await h.context.loadJournal();
  expect(h.context.jrApi.mock.calls.map(c => c[0])).toEqual(['day?date=2030-04-03', 'week?date=2030-04-03']);
  const html = h.get('jrGrid').innerHTML;
  expect((html.match(/<div class="jr-column"/g) || []).length).toBe(7);
  expect(html).toContain('пн 01.04');
  expect(html).toContain('data-date="2030-04-07"');
  expect(html).toContain('data-record="8"');
  expect(h.run('journal.data.date')).toBe('2030-04-03');
});
test('week: staff filter is sent; arrows move by 7 days', async () => {
  const h = harness(); h.get('jrDate').value = '2030-04-03'; h.get('jrStaffFilter').value = '1';
  h.context.jrApi = jest.fn(async p => (p.startsWith('week') ? WEEK : DAY));
  h.context.jrUpdateDispatchButton = jest.fn();   // harness nodes have no classList
  h.run(`journal.view = 'week'`);
  await h.context.loadJournal();
  expect(h.context.jrApi.mock.calls[1][0]).toBe('week?date=2030-04-03&staffId=1');
  h.context.loadJournal = jest.fn();
  h.context.jrShift(1);
  expect(h.get('jrDate').value).toBe('2030-04-10');
});
test('week: a free cell of another day opens the form on that day', () => {
  const h = harness();
  h.run(`journal.view='week'; journal.data = ${JSON.stringify(DAY)}; journal.week = ${JSON.stringify(WEEK)};`);
  h.context.jrForm = jest.fn();
  h.context.jrGridCreate(1, '09:00', '2030-04-01');
  expect(h.context.jrForm).toHaveBeenCalledWith(null, { staffId: 1, time: '09:00', date: '2030-04-01' });
  h.context.jrGridCreate(1, '09:00', '2030-04-02');   // day off
  expect(h.context.jrForm).toHaveBeenCalledTimes(1);
});
test('month cells start on Monday and carry density', () => {
  const h = harness();
  const cells = h.context.jrMonthCells('2026-11', [{ date: '2026-11-02', records: 12, workingStaff: 4, density: 2 }]);
  expect(cells).toHaveLength(36);                    // 1 Nov 2026 is a Sunday: 6 blanks
  expect(cells.slice(0, 6)).toEqual([null, null, null, null, null, null]);
  expect(cells[7]).toEqual({ date: '2026-11-02', day: 2, records: 12, density: 2 });
  expect(h.context.jrMonthAdd('2026-12', 1)).toBe('2027-01');
});
test('month picker renders days with dots and survives an API error', async () => {
  const h = harness(); h.get('jrDate').value = '2026-11-12';
  h.context.jrApi = jest.fn().mockResolvedValue({ month: '2026-11', days: [{ date: '2026-11-02', records: 12, workingStaff: 4, density: 2 }] });
  await h.context.jrMonthPicker();
  expect(h.context.jrApi).toHaveBeenCalledWith('month?month=2026-11');
  const html = h.get('jrMonth').innerHTML;
  expect(html).toContain('data-month-date="2026-11-02"');
  expect(html).toContain('jr-density-2');
  expect(html).toContain('data-month-date="2026-11-12" title="Записей: 0"');
  expect(h.get('jrMonth').hidden).toBe(false);
  h.context.jrApi = jest.fn().mockRejectedValue(new Error('<b>нет связи</b>'));
  await h.context.jrMonthPicker('2026-12');
  expect(h.get('jrMonth').innerHTML).toContain('&lt;b&gt;нет связи');
});
test('phone (≤700px): one master and chips; week is not offered', async () => {
  const h = harness(); h.context.window = { matchMedia: q => ({ matches: q === '(max-width: 700px)' }) };
  h.get('jrWorkingOnly').checked = false;
  h.run(`journal.data = {date:'2030-04-01',labels:[],staff:[{id:1,name:'Юлия',working:true,workRanges:[]},{id:2,name:'Пери',working:true,workRanges:[]}],records:[]}; jrRender()`);
  expect((h.get('jrGrid').innerHTML.match(/<div class="jr-column"/g) || []).length).toBe(1);
  expect(h.get('jrStaffChips').hidden).toBe(false);
  expect(h.get('jrStaffChips').innerHTML).toContain('data-chip="2"');
  h.context.loadJournal = jest.fn();
  h.context.jrSetView('week');
  expect(h.run('journal.view')).toBe('day');
});
test('the 700px threshold is the same in JS and CSS', () => {
  const h = harness();
  expect(h.run('JR_MOBILE_MAX')).toBe(700);
  const css = fs.readFileSync(path.join(__dirname, '../frontend/css/journal.css'), 'utf8');
  expect(css).toMatch(/@media \(max-width:700px\)\{\s*#jrViewWeek\{display:none\}/);
});
```

- [ ] **Step 2: Запустить — падают**

Run: `cd /root/loyalpro/backend && npx jest backend/journal-ui --silent`
Expected: FAIL — один вызов API вместо двух, `jrMonthCells is not a function`, `JR_MOBILE_MAX is not defined`.

- [ ] **Step 3: `journal.js`**

Первую строку состояния
```js
const journal = { data: null, request: 0, modalRequest: 0, slotRequest: 0, busy: false, draft: null, slots: [], preferredTime: null };
```
заменить на
```js
const journal = { data: null, week: null, view: 'day', request: 0, modalRequest: 0, slotRequest: 0, busy: false, draft: null, slots: [], preferredTime: null };
// Phone layout threshold: the same number is in journal.css (@media (max-width:700px)) — change both together.
const JR_MOBILE_MAX = 700;
const jrIsMobile = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(`(max-width: ${JR_MOBILE_MAX}px)`).matches;
```

В `loadJournal` строку
```js
    const data = await jrApi('day?' + new URLSearchParams({ date }));
    if (request !== journal.request) return;
```
заменить на
```js
    // Week = one master × 7 days; the day is still loaded: forms need its services/staff.
    if (jrIsMobile()) journal.view = 'day';
    const staffId = jrEl('jrStaffFilter').value;
    const [data, week] = await Promise.all([
      jrApi('day?' + new URLSearchParams({ date })),
      journal.view === 'week' ? jrApi('week?' + new URLSearchParams({ date, ...(staffId ? { staffId } : {}) })) : Promise.resolve(null),
    ]);
    if (request !== journal.request) return;
    journal.week = week;
```

Функцию `jrShift` заменить на:
```js
function jrShift(days) {
  if (journal.view === 'week') days *= 7;
  const d = new Date((jrEl('jrDate').value || jrToday()) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days); jrEl('jrDate').value = d.toISOString().slice(0, 10); loadJournal();
}
function jrSetView(view) {
  journal.view = view === 'week' && !jrIsMobile() ? 'week' : 'day';
  for (const [id, v] of [['jrViewDay', 'day'], ['jrViewWeek', 'week']]) {
    const b = jrEl(id);
    b.classList?.toggle('is-active', journal.view === v);
    b.setAttribute?.('aria-pressed', String(journal.view === v));
  }
  loadJournal();
}
// In the week the master is part of the request; in the day the filter is local.
function jrStaffChanged() {
  if (journal.view === 'week') loadJournal({ silent: true });
  else jrRender();
}
```

- [ ] **Step 4: `journal-grid.js`**

Функцию `jrGridCreate` заменить на:
```js
function jrGridCreate(staffId, time, date) {
  if (!journal.data) return;
  const day = journal.view === 'week' && journal.week ? journal.week.days.find(d => d.date === date) : null;
  const staff = day ? { id: journal.week.staff.id, workRanges: day.workRanges || [] } : jrStaffList().find(s => s.id === staffId);
  const when = day ? day.date : journal.data.date;
  if (!staff || jrCellState(staff, jrMinutes(time), when, day ? day.records : journal.data.records) !== 'free') return;
  jrForm(null, { staffId, time, date: when });
}
```

В `jrRender` строки
```js
  if (!journal.data) return;
  const filter = jrEl('jrStaffFilter').value;
  const staff = jrStaffList().filter(s => !filter || String(s.id) === filter);
```
заменить на
```js
  if (!journal.data) return;
  if (journal.view === 'week' && journal.week) return jrRenderWeek();
  const filter = jrEl('jrStaffFilter').value;
  let staff = jrStaffList().filter(s => !filter || String(s.id) === filter);
  // Phone: one master at a time, switched by chips (spec §3.1).
  const mobile = jrIsMobile();
  if (mobile && staff.length > 1) staff = staff.slice(0, 1);
  jrRenderChips(mobile, staff[0]?.id);
```

После функции `jrRender` добавить:

```js
const JR_WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
function jrRenderWeek() {
  const w = journal.week, grid = jrEl('jrGrid');
  jrRenderChips(false);
  if (!w?.staff) { grid.innerHTML = '<p class="jr-empty">Специалистов пока нет.</p>'; return; }
  const query = jrEl('jrSearch').value.trim().toLowerCase();
  const match = r => !query || [r.clientName, ...r.services.map(s => s.title)].join(' ').toLowerCase().includes(query);
  const { start, end } = jrBounds(w.days.flatMap(d => d.records), w.days.flatMap(d => d.workRanges || []));
  const now = Date.now();
  const column = d => ({ id: w.staff.id, name: w.staff.name, workRanges: d.workRanges || [] });
  grid.innerHTML = `<div class="jr-calendar jr-week" data-start="${start}" style="--jr-columns:7;--jr-height:${(end - start) * JR_PX_PER_MIN}px"><div class="jr-corner">${jrEscape(w.staff.name)}</div>${w.days.map((d, i) => `<div class="jr-heading${d.date === journal.data?.date ? ' is-selected' : ''}">${JR_WEEKDAYS[i]} ${d.date.slice(8, 10)}.${d.date.slice(5, 7)}<small>${d.working ? (d.workRanges || []).map(r => jrTimeLabel(r.start) + '–' + jrTimeLabel(r.end)).join(', ') || 'Рабочий день' : 'Выходной'} · ${d.records.length} записей</small></div>`).join('')}<div class="jr-hours">${jrHourLabels(start, end)}</div>${w.days.map(d => jrColumnHtml(column(d), d.date, d.records.filter(match), d.records, start, end, now)).join('')}</div>`;
  jrBindGrid(grid);
}
function jrRenderChips(mobile, currentId) {
  const box = jrEl('jrStaffChips');
  if (!box) return;
  box.hidden = !mobile;
  if (!mobile) { box.innerHTML = ''; return; }
  box.innerHTML = jrStaffList().map(s => `<button type="button" class="jr-chip${s.id === currentId ? ' is-active' : ''}" data-chip="${s.id}" aria-pressed="${s.id === currentId}">${jrEscape(s.name)}</button>`).join('');
  box.querySelectorAll('[data-chip]').forEach(b => { b.onclick = () => { jrEl('jrStaffFilter').value = b.dataset.chip; jrRender(); }; });
}
// Month calendar with day load (spec §3.1): Monday first, density 0–3 from the server.
function jrMonthCells(month, days) {
  const first = new Date(month + '-01T12:00:00Z');
  const lead = (first.getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const byDate = new Map((days || []).map(d => [d.date, d]));
  const cells = Array.from({ length: lead }, () => null);
  for (let i = 1; i <= count; i++) {
    const date = `${month}-${String(i).padStart(2, '0')}`, d = byDate.get(date);
    cells.push({ date, day: i, records: Number(d?.records) || 0, density: Number(d?.density) || 0 });
  }
  return cells;
}
const jrMonthAdd = (month, n) => { const d = new Date(month + '-01T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
async function jrMonthPicker(month) {
  const box = jrEl('jrMonth');
  month = month || (jrEl('jrDate').value || jrToday()).slice(0, 7);
  const request = journal.monthRequest = (journal.monthRequest || 0) + 1;
  box.hidden = false;
  box.innerHTML = '<p class="jr-hint">Загрузка…</p>';
  let data;
  try { data = await jrApi('month?' + new URLSearchParams({ month })); }
  catch (e) { if (request === journal.monthRequest) box.innerHTML = `<p class="jr-hint">${jrEscape(e.message)}</p><button type="button" class="btn btn-sec" data-month-close>Закрыть</button>`; return; }
  if (request !== journal.monthRequest) return;
  const title = new Date(month + '-01T12:00:00Z').toLocaleDateString('ru', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const selected = jrEl('jrDate').value;
  box.innerHTML = `<div class="jr-month-head"><button type="button" class="btn btn-sec" data-month-shift="-1" aria-label="Предыдущий месяц">←</button><strong>${jrEscape(title)}</strong><button type="button" class="btn btn-sec" data-month-shift="1" aria-label="Следующий месяц">→</button><button type="button" class="btn btn-sec" data-month-close aria-label="Закрыть календарь">✕</button></div><div class="jr-month-grid">${JR_WEEKDAYS.map(d => `<span class="jr-month-wd">${d}</span>`).join('')}${jrMonthCells(month, data.days).map(c => c ? `<button type="button" class="jr-month-day${c.date === selected ? ' is-current' : ''}" data-month-date="${c.date}" title="Записей: ${c.records}"><span>${c.day}</span><i class="jr-density jr-density-${c.density}" aria-hidden="true">${'•'.repeat(c.density)}</i></button>` : '<span></span>').join('')}</div>`;
  box.querySelectorAll('[data-month-date]').forEach(b => { b.onclick = () => { jrEl('jrDate').value = b.dataset.monthDate; box.hidden = true; loadJournal(); }; });
  box.querySelectorAll('[data-month-shift]').forEach(b => { b.onclick = () => jrMonthPicker(jrMonthAdd(month, Number(b.dataset.monthShift))); });
  box.querySelectorAll('[data-month-close]').forEach(b => { b.onclick = () => { box.hidden = true; }; });
}
// Crossing the 700px threshold re-lays the grid (one master ↔ all masters).
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  let jrResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(jrResizeTimer);
    jrResizeTimer = setTimeout(() => { if (document.body?.dataset?.page === 'journal') jrRender(); }, 200);
  });
}
```

Готча: блок `if (typeof window …) { let jrResizeTimer … }` — `let` внутри блока, а не верхнеуровневый: тест «нет дублей» его не видит, и конфликтов с другими файлами он не создаёт.

- [ ] **Step 5: `index.html` и CSS**

Тулбар журнала: строку
```html
        <input id="jrDate" type="date" aria-label="Дата журнала" onchange="loadJournal()">
```
заменить на
```html
        <input id="jrDate" type="date" aria-label="Дата журнала" onchange="loadJournal()">
        <button class="btn btn-sec" id="jrMonthBtn" onclick="jrMonthPicker()" aria-label="Календарь месяца" title="Календарь месяца">📅</button>
```
строку
```html
        <button class="btn btn-sec" onclick="jrEl('jrDate').value=jrToday();loadJournal()">Сегодня</button>
```
заменить на
```html
        <button class="btn btn-sec" onclick="jrEl('jrDate').value=jrToday();loadJournal()">Сегодня</button>
        <span class="jr-view-switch" role="group" aria-label="Вид журнала"><button class="btn btn-sec is-active" id="jrViewDay" aria-pressed="true" onclick="jrSetView('day')">День</button><button class="btn btn-sec" id="jrViewWeek" aria-pressed="false" onclick="jrSetView('week')">Неделя</button></span>
```
в строке фильтра мастера заменить `onchange="jrRender()"` на `onchange="jrStaffChanged()"` (только у `<select id="jrStaffFilter" …>`).
Строку
```html
      <p id="jrState" class="jr-state" role="status" aria-live="polite"></p>
```
заменить на
```html
      <div id="jrMonth" class="jr-month" hidden></div>
      <p id="jrState" class="jr-state" role="status" aria-live="polite"></p>
      <div id="jrStaffChips" class="jr-staff-chips" hidden role="group" aria-label="Специалист"></div>
```
Бамп: `journal.js?v=split-2026-11-12` → `?v=t10-2026-11-12`, `journal-grid.js?v=t9-2026-11-12` → `?v=t10-2026-11-12`, `css/journal.css?v=t9-2026-11-12` → `?v=t10-2026-11-12`.

В конец `frontend/css/journal.css`:

```css
/* Week view, month calendar, phone day (12.11.2026). 700px = JR_MOBILE_MAX in journal.js. */
.jr-view-switch{display:inline-flex}
.jr-view-switch .btn{border-radius:0}
.jr-view-switch .btn:first-child{border-radius:8px 0 0 8px}
.jr-view-switch .btn:last-child{border-radius:0 8px 8px 0}
.jr-view-switch .btn.is-active{background:var(--as);color:var(--a);border-color:var(--a)}
.jr-week .jr-heading.is-selected{color:var(--a)}
.jr-month{position:relative;z-index:6;max-width:340px;margin:0 0 12px;padding:12px;border:1px solid var(--bd);border-radius:12px;background:var(--card);box-shadow:0 8px 24px rgba(0,0,0,.12)}
.jr-month[hidden]{display:none}
.jr-month-head{display:flex;align-items:center;gap:6px;margin-bottom:8px}
.jr-month-head strong{flex:1;text-align:center;text-transform:capitalize}
.jr-month-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.jr-month-wd{font-size:11px;color:var(--t3);text-align:center}
.jr-month-day{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 0;border:1px solid var(--bd);border-radius:8px;background:var(--card);color:inherit;font:inherit;font-size:13px;cursor:pointer}
.jr-month-day.is-current{border-color:var(--a);color:var(--a);font-weight:600}
.jr-density{font-style:normal;font-size:10px;line-height:1;min-height:10px;color:var(--a)}
.jr-density-3{color:var(--danger,#a64635)}
.jr-staff-chips[hidden]{display:none}
@media (max-width:700px){
  #jrViewWeek{display:none}
  .jr-staff-chips{display:flex;gap:6px;overflow-x:auto;padding:0 0 10px}
  .jr-chip{flex:0 0 auto;padding:6px 12px;border:1px solid var(--bd);border-radius:16px;background:var(--card);color:inherit;font:inherit;font-size:13px}
  .jr-chip.is-active{border-color:var(--a);background:var(--as);color:var(--a)}
  .jr-calendar{grid-template-columns:46px minmax(0,1fr);min-width:0}
  .jr-toolbar input,.jr-toolbar select{max-width:none}
}
```

- [ ] **Step 6: Зелёные**

Run: `npx jest backend/journal-ui --silent` → PASS (89 тестов).
Run: `npx jest backend/journal service-catalog finance bonus-ledger --silent` → зелёные.

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro && git add frontend/js/pages/journal.js frontend/js/pages/journal-grid.js frontend/css/journal.css frontend/index.html backend/journal-ui.test.js && git commit -m "feat(journal): вид «Неделя», календарь месяца с загрузкой дней, мобильный день с чипами мастеров

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 11: Сетка — перенос перетаскиванием и растягивание длительности

**Исполнитель:** Opus. **Зависимости:** T3 (`edit.seanceLength`), T10 (неделя: `journal.week`, `jrBindGrid`).

**Files:**
- Modify: `frontend/js/pages/journal-grid.js` (`jrColumnHtml` — класс и ручка, `jrBindGrid`; новые `JR_DRAG_STEP`, `JR_DRAG_THRESHOLD`, `jrSnap`, `jrDragAllowed`, `jrDragRecords`, `jrColumnContext`, `jrDropCheck`, `jrDragStart`, `jrDragTarget`, `jrDragMove`, `jrDragCancel`, `jrDragEnd`, `jrDragSave`, `jrDragBegin`)
- Modify: `frontend/css/journal.css`, `frontend/index.html` (бамп)
- Test: `backend/journal-ui.test.js`

Поведение (спека §3.3):
- Перенос: pointer-события на блоке записи. Сдвиг по вертикали → время (шаг 5 мин от времени записи, «как у слотов»), колонка под указателем (`document.elementFromPoint` → `.jr-column` с `data-staff`/`data-date`) → мастер и дата (в неделе — другой день того же мастера). Проверка по данным сетки (`jrDropCheck`: внутри графика, не в прошлом, не поверх другой записи того же мастера с учётом технических перерывов) → `confirm('Перенести запись Анна на 14:00 к специалисту Пери?')` → одна сессия `{sessionId, recordId, move:{date,time,staffId}}`. Окончательную проверку делает сервер; отказ → `notify(текст, 'err')` и перерисовка (блок возвращается).
- Растягивание: ручка `<i class="jr-resize" data-resize="1">` внизу блока; длительность = старая + сдвиг, шаг 5, 5…720 → `confirm('Длительность 60 → 75 мин?')` → сессия `{sessionId, recordId, edit:{seanceLength}}`. Проверка «в прошлом» для растягивания не применяется (уже идущий визит продлевать можно, сервер это разрешает).
- Не перетаскиваются: «Продолжение» (`continued`), удалённые, оплаченные, «пришёл»/«не пришёл», пакет в пути (`jrSyncing`) или с ошибкой. Неотправленные (`released:false`) — можно: это такая же правка карточки.
- Клик без сдвига (меньше 4 px) — обычное открытие карточки; клик сразу после перетаскивания (400 мс) подавляется.
- Подтверждение по-русски не склоняет имя («к специалисту Юлия», а не «к Юлии», как в примере спеки): имя мастера произвольное, автоматическое склонение даёт ошибки.

Готчи:
- Перетаскиваемому блоку на время движения ставится `pointer-events:none`, иначе `elementFromPoint` вернёт сам блок, и `closest('.jr-column')` всегда даст исходную колонку. Обработчики `pointermove/up/cancel` вешаются на `document` (а не на блок) по той же причине.
- Ручка — `<i>`, а не `<span>`: правило `.jr-visit-short>span{display:none}` спрятало бы её у коротких визитов.
- `touch-action:none` только для `(pointer:fine)`: на телефоне палец по блоку должен листать сетку.

- [ ] **Step 1: Падающие тесты**

В конец `backend/journal-ui.test.js`:

```js
// ---- Drag-and-drop (12.11.2026): synthetic pointer events ----
const DRAG_DAY = `journal.view='day'; journal.data = {date:'2030-04-01',labels:[],
  staff:[{id:1,name:'Юлия',working:true,workRanges:[{start:540,end:1080}]},{id:2,name:'Пери',working:true,workRanges:[{start:540,end:1080}]}],
  records:[{id:8,staffId:1,date:'2030-04-01',time:'10:00',duration:60,clientName:'Анна',attendance:0,services:[]},
           {id:9,staffId:2,date:'2030-04-01',time:'12:00',duration:60,clientName:'Борис',attendance:0,services:[]}]}`;
const columnAt = (staff, date) => () => ({ closest: () => ({ dataset: { staff: String(staff), date } }) });
function dragHarness() {
  const h = harness(); h.run(DRAG_DAY);
  h.context.confirm = jest.fn(() => true);
  h.context.jrApi = jest.fn().mockResolvedValue({ outboxId: 3, recordId: 8, status: 'queued' });
  h.context.loadJournal = jest.fn(); h.context.jrRender = jest.fn();
  return h;
}
test('drag: move to another master, confirmed, sends one move session', async () => {
  const h = dragHarness(); h.context.document.elementFromPoint = columnAt(2, '2030-04-01');
  expect(h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'move')).toBe(true);
  h.context.jrDragMove({ clientX: 300, clientY: 100 + 240 * 1.6 });
  expect(await h.context.jrDragEnd({ clientX: 300, clientY: 100 + 240 * 1.6 })).toBe(true);
  expect(h.context.confirm).toHaveBeenCalledWith('Перенести запись Анна на 14:00 к специалисту Пери?');
  expect(h.context.jrApi).toHaveBeenCalledWith('sessions', { sessionId: 'synthetic-uuid-1', recordId: 8, move: { date: '2030-04-01', time: '14:00', staffId: 2 } });
  expect(h.context.loadJournal).toHaveBeenCalledWith({ silent: true });
  expect(h.run('journal.drag')).toBe(null);
});
test('drag: 5-minute grid; cancelling the confirmation changes nothing', async () => {
  const h = dragHarness(); h.context.document.elementFromPoint = columnAt(1, '2030-04-01');
  h.context.confirm = jest.fn(() => false);
  h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'move');
  expect(await h.context.jrDragEnd({ clientX: 100, clientY: 100 + 37 * 1.6 })).toBe(false);
  expect(h.context.confirm).toHaveBeenCalledWith('Перенести запись Анна на 10:35 к специалисту Юлия?');
  expect(h.context.jrApi).not.toHaveBeenCalled();
  expect(h.context.jrRender).toHaveBeenCalled();
});
test('drag: over another visit of that master is refused before asking', async () => {
  const h = dragHarness(); h.context.document.elementFromPoint = columnAt(2, '2030-04-01');
  h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'move');
  expect(await h.context.jrDragEnd({ clientX: 300, clientY: 100 + 120 * 1.6 })).toBe(false);   // 12:00 at Пери = Борис
  expect(h.context.notify).toHaveBeenCalledWith('Время занято другой записью.', 'err');
  expect(h.context.confirm).not.toHaveBeenCalled();
  expect(h.context.jrApi).not.toHaveBeenCalled();
});
test('drag: outside the shift is refused', async () => {
  const h = dragHarness(); h.context.document.elementFromPoint = columnAt(1, '2030-04-01');
  h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'move');
  expect(await h.context.jrDragEnd({ clientX: 100, clientY: 100 + 450 * 1.6 })).toBe(false);   // 17:30 + 60 > 18:00
  expect(h.context.notify).toHaveBeenCalledWith('Это время вне рабочего графика специалиста.', 'err');
});
test('resize: confirmed new length goes as edit.seanceLength', async () => {
  const h = dragHarness();
  h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'resize');
  h.context.jrDragMove({ clientX: 100, clientY: 100 + 15 * 1.6 });
  expect(await h.context.jrDragEnd({ clientX: 100, clientY: 100 + 15 * 1.6 })).toBe(true);
  expect(h.context.confirm).toHaveBeenCalledWith('Длительность 60 → 75 мин?');
  expect(h.context.jrApi).toHaveBeenCalledWith('sessions', { sessionId: 'synthetic-uuid-1', recordId: 8, edit: { seanceLength: 75 } });
});
test('server refusal: message shown, block returns', async () => {
  const h = dragHarness(); h.context.document.elementFromPoint = columnAt(1, '2030-04-01');
  h.context.jrApi = jest.fn().mockRejectedValue(Object.assign(new Error('Время уже занято. Выберите другое.'), { status: 409, code: 'slot_taken' }));
  h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'move');
  expect(await h.context.jrDragEnd({ clientX: 100, clientY: 100 + 60 * 1.6 })).toBe(false);
  expect(h.context.notify).toHaveBeenCalledWith('Время уже занято. Выберите другое.', 'err');
  expect(h.context.jrRender).toHaveBeenCalled();
  expect(h.context.loadJournal).not.toHaveBeenCalled();
});
test('a tiny movement is a click; locked records do not start a drag', async () => {
  const h = dragHarness();
  h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'move');
  expect(await h.context.jrDragEnd({ clientX: 101, clientY: 102 })).toBe(false);
  expect(h.context.confirm).not.toHaveBeenCalled();
  const base = { id: 1, time: '10:00', attendance: 0 };
  expect(h.context.jrDragAllowed(base)).toBe(true);
  for (const r of [{ ...base, continued: true }, { ...base, paid: true }, { ...base, deleted: true }, { ...base, attendance: 1 }, { ...base, attendance: -1 },
    { ...base, sync: { status: 'running', released: true } }, { ...base, sync: { status: 'failed' } }]) expect(h.context.jrDragAllowed(r)).toBe(false);
  expect(h.context.jrDragAllowed({ ...base, sync: { status: 'queued', released: false } })).toBe(true);
  expect(h.context.jrDragStart({ button: 2, clientX: 0, clientY: 0 }, 8, 'move')).toBe(false);
});
test('week: dropping on another day of the same master', async () => {
  const h = dragHarness();
  h.run(`journal.view='week'; journal.week = {staff:{id:1,name:'Юлия'},days:[
    {date:'2030-04-01',workRanges:[{start:540,end:1080}],records:[{id:8,staffId:1,date:'2030-04-01',time:'10:00',duration:60,clientName:'Анна',attendance:0,services:[]}]},
    {date:'2030-04-02',workRanges:[{start:540,end:1080}],records:[]}]}`);
  h.context.document.elementFromPoint = columnAt(1, '2030-04-02');
  h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'move');
  expect(await h.context.jrDragEnd({ clientX: 300, clientY: 100 })).toBe(true);
  expect(h.context.confirm).toHaveBeenCalledWith('Перенести запись Анна на 02.04 10:00 к специалисту Юлия?');
  expect(h.context.jrApi.mock.calls[0][1].move).toEqual({ date: '2030-04-02', time: '10:00', staffId: 1 });
});
test('draggable blocks get the resize handle', () => {
  const h = harness(); h.run(DRAG_DAY + ';jrRender()');
  const html = h.get('jrGrid').innerHTML;
  expect(html).toContain('jr-draggable" data-record="8"');
  expect(html).toContain('<i class="jr-resize" data-resize="1" aria-hidden="true"></i>');
});
```

Готча теста: `dragHarness` подменяет `jrRender` заглушкой — поэтому последний тест строит свой `harness()` без подмены.

- [ ] **Step 2: Запустить — падают**

Run: `cd /root/loyalpro/backend && npx jest backend/journal-ui --silent`
Expected: FAIL — `h.context.jrDragStart is not a function`.

- [ ] **Step 3: Реализация в `journal-grid.js`**

В `jrColumnHtml`, в строке, собирающей `<button type="button" class="jr-visit …`, сделать две замены:
1. `${failed ? ' jr-visit-failed' : ''}" data-record="${r.id}"` → `${failed ? ' jr-visit-failed' : ''}${jrDragAllowed(r) ? ' jr-draggable' : ''}" data-record="${r.id}"`
2. в конце той же строки `: ''}</button>${band}` → `: ''}${jrDragAllowed(r) ? '<i class="jr-resize" data-resize="1" aria-hidden="true"></i>' : ''}</button>${band}`

Функцию `jrBindGrid` заменить на:

```js
function jrBindGrid(grid) {
  grid.querySelectorAll('[data-record]').forEach(el => {
    // A click right after a drag is the end of that drag, not «open the card».
    el.addEventListener('click', () => { if (Date.now() < (journal.suppressClickUntil || 0)) return; jrOpen(Number(el.dataset.record)); });
    el.addEventListener('pointerdown', ev => jrDragBegin(el, ev));
  });
  grid.querySelectorAll('[data-time]').forEach(el => el.addEventListener('click', () => jrGridCreate(Number(el.dataset.staff), el.dataset.time, el.dataset.date)));
}
```

В конец файла добавить:

```js
// ---- Drag-and-drop: move and resize (spec 2026-11-12 §3.3) ----
const JR_DRAG_STEP = 5, JR_DRAG_THRESHOLD = 4;
const jrSnap = minute => Math.round(minute / JR_DRAG_STEP) * JR_DRAG_STEP;
// Same locks as the card: no continuation, paid, arrived/no-show, package on its way or failed.
function jrDragAllowed(r) {
  return !!r && !r.continued && !r.deleted && !r.paid && !jrSyncing(r) && r.sync?.status !== 'failed'
    && r.attendance !== 1 && r.attendance !== -1 && /^\d\d:\d\d$/.test(r.time || '');
}
function jrDragRecords() {
  return journal.view === 'week' && journal.week ? journal.week.days.flatMap(d => d.records) : (journal.data?.records || []);
}
// Staff (with shift) and the visits of the column the block is dropped on.
function jrColumnContext(staffId, date) {
  if (journal.view === 'week' && journal.week) {
    const d = journal.week.days.find(x => x.date === date);
    if (!d || Number(staffId) !== journal.week.staff.id) return null;
    return { staff: { id: journal.week.staff.id, name: journal.week.staff.name, workRanges: d.workRanges || [] }, records: d.records };
  }
  const s = (journal.data?.staff || []).find(x => x.id === Number(staffId));
  return s ? { staff: s, records: journal.data.records } : null;
}
// Grid-side check; the server re-checks (busy/slot_taken).
function jrDropCheck({ record, staff, date, minute, duration, records, now = Date.now() }) {
  const occupied = (duration > 0 ? duration : 15) + (Number(record.technicalBreak) > 0 ? Number(record.technicalBreak) / 60 : 0);
  if (!(staff.workRanges || []).some(r => minute >= r.start && minute + occupied <= r.end)) return { ok: false, reason: 'Это время вне рабочего графика специалиста.' };
  if (Date.parse(date + 'T00:00:00+03:00') + minute * 60000 <= now) return { ok: false, reason: 'Это время уже прошло.' };
  const clash = (records || []).some(r => r.id !== record.id && r.staffId === staff.id && !r.deleted && r.time && (!r.date || r.date === date)
    && minute < jrMinutes(r.time) + jrOccupied(r) && minute + occupied > jrMinutes(r.time));
  return clash ? { ok: false, reason: 'Время занято другой записью.' } : { ok: true };
}
function jrDragStart(ev, recordId, mode) {
  if (ev.button !== undefined && ev.button !== 0) return false;
  const record = jrDragRecords().find(r => r.id === recordId);
  if (!jrDragAllowed(record)) return false;
  journal.drag = { record, mode, x: ev.clientX, y: ev.clientY, moved: false, el: null };
  return true;
}
function jrDragTarget(ev) {
  const d = journal.drag, r = d.record;
  const delta = (ev.clientY - d.y) / JR_PX_PER_MIN;
  if (d.mode === 'resize') return { kind: 'resize', duration: Math.min(720, Math.max(5, jrSnap(r.duration + delta))) };
  const el = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(ev.clientX, ev.clientY) : null;
  const col = el && typeof el.closest === 'function' ? el.closest('.jr-column') : null;
  if (!col?.dataset?.date) return null;
  return { kind: 'move', staffId: Number(col.dataset.staff), date: col.dataset.date, minute: Math.min(1435, Math.max(0, jrSnap(jrMinutes(r.time) + delta))) };
}
function jrDragMove(ev) {
  const d = journal.drag;
  if (!d) return null;
  if (!d.moved && Math.abs(ev.clientX - d.x) + Math.abs(ev.clientY - d.y) < JR_DRAG_THRESHOLD) return null;
  // The moving block must not be «the element under the pointer».
  if (!d.moved && d.el?.style) { d.el.style.pointerEvents = 'none'; d.el.classList?.add('jr-visit-dragging'); }
  d.moved = true;
  const target = jrDragTarget(ev);
  if (d.el?.style) {
    if (d.mode === 'resize' && target) d.el.style.height = Math.max(6, target.duration * JR_PX_PER_MIN - 2) + 'px';
    else if (d.mode === 'move') d.el.style.transform = `translate(${ev.clientX - d.x}px, ${ev.clientY - d.y}px)`;
  }
  return target;
}
function jrDragCancel() { journal.drag = null; jrRender(); }
async function jrDragEnd(ev) {
  const d = journal.drag;
  if (!d) return false;
  const moved = d.moved || Math.abs(ev.clientX - d.x) + Math.abs(ev.clientY - d.y) >= JR_DRAG_THRESHOLD;
  const target = moved ? jrDragTarget(ev) : null;
  journal.drag = null;
  if (d.el?.style) { d.el.style.pointerEvents = ''; d.el.style.transform = ''; d.el.classList?.remove('jr-visit-dragging'); }
  if (!moved) return false;                       // a plain click: the click handler opens the card
  journal.suppressClickUntil = Date.now() + 400;
  const r = d.record;
  const back = () => { jrRender(); return false; };  // the block returns to its place
  if (!target) return back();
  if (target.kind === 'resize') {
    if (target.duration === r.duration) return back();
    const ctx = jrColumnContext(r.staffId, r.date);
    // A visit already under way may be extended: no «past» check for resize.
    const check = ctx ? jrDropCheck({ record: r, staff: ctx.staff, date: r.date, minute: jrMinutes(r.time), duration: target.duration, records: ctx.records, now: 0 })
      : { ok: false, reason: 'Специалист не найден в сетке.' };
    if (!check.ok) { notify(check.reason, 'err'); return back(); }
    if (!confirm(`Длительность ${r.duration} → ${target.duration} мин?`)) return back();
    return jrDragSave({ sessionId: crypto.randomUUID(), recordId: r.id, edit: { seanceLength: target.duration } });
  }
  const ctx = jrColumnContext(target.staffId, target.date);
  const time = jrTimeLabel(target.minute);
  if (!ctx || (target.staffId === r.staffId && target.date === r.date && time === r.time)) return back();
  const check = jrDropCheck({ record: r, staff: ctx.staff, date: target.date, minute: target.minute, duration: r.duration, records: ctx.records });
  if (!check.ok) { notify(check.reason, 'err'); return back(); }
  const day = target.date === r.date ? '' : ` ${target.date.slice(8, 10)}.${target.date.slice(5, 7)}`;
  if (!confirm(`Перенести запись ${r.clientName} на${day} ${time} к специалисту ${ctx.staff.name || ''}?`)) return back();
  return jrDragSave({ sessionId: crypto.randomUUID(), recordId: r.id, move: { date: target.date, time, staffId: target.staffId } });
}
// Same session endpoint as the forms; saved locally, sent by «Отправить в YClients».
async function jrDragSave(body) {
  try {
    await jrApi('sessions', body);
    notify('Сохранено в журнале. В YClients — кнопкой «Отправить в YClients».');
    loadJournal({ silent: true });
    return true;
  } catch (e) {
    notify(e.message, 'err');
    jrRender();
    return false;
  }
}
function jrDragBegin(el, ev) {
  const mode = ev.target?.dataset?.resize ? 'resize' : 'move';
  if (!jrDragStart(ev, Number(el.dataset.record), mode)) return;
  journal.drag.el = el;
  ev.preventDefault?.();
  const move = e => jrDragMove(e);
  const up = e => { off(); jrDragEnd(e); };
  const cancel = () => { off(); jrDragCancel(); };
  const off = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', cancel);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', cancel);
}
```

Проверка расчёта в тесте «10:35»: сдвиг 37 мин → `jrSnap(600 + 37) = 635` → 10:35. В тесте «вне графика»: 600 + 450 = 1050 (17:30), 1050 + 60 > 1080 → отказ.

- [ ] **Step 4: CSS и кэш**

В конец `frontend/css/journal.css`:

```css
/* Drag-and-drop (12.11.2026). */
.jr-resize{position:absolute;left:0;right:0;bottom:0;height:7px;cursor:ns-resize}
.jr-visit.jr-draggable{user-select:none;-webkit-user-select:none}
@media (pointer:fine){.jr-visit.jr-draggable{touch-action:none;cursor:grab}}
.jr-visit.jr-visit-dragging{opacity:.75;z-index:5;box-shadow:0 6px 18px rgba(0,0,0,.2);cursor:grabbing}
```
Бамп: `journal-grid.js?v=t10-2026-11-12` → `?v=t11-2026-11-12`, `css/journal.css?v=t10-2026-11-12` → `?v=t11-2026-11-12`.

- [ ] **Step 5: Зелёные**

Run: `npx jest backend/journal-ui --silent` → PASS (98 тестов).
Run: `npx jest backend/journal service-catalog finance bonus-ledger --silent` → зелёные.

- [ ] **Step 6: Ручная проверка в браузере (без сохранения)**

`PORT=3001 pm2 restart loyalpro`, открыть журнал на деве, потянуть блок записи будущего дня и на вопросе нажать «Отмена»: блок вернулся, в DevTools → Network нет `POST /api/journal/sessions`. Клик по блоку без движения открывает карточку. (Полная автоматическая проверка — задача 14.)

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro && git add frontend/js/pages/journal-grid.js frontend/css/journal.css frontend/index.html backend/journal-ui.test.js && git commit -m "feat(journal): перенос записи перетаскиванием и растягивание длительности с подтверждением

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 12: Карточка — телефон, комментарий, длительность, клиент, цвет, метки, перерыв, «не уведомлять», удаление, «Записать повторно»

**Исполнитель:** Sonnet. **Зависимости:** T1, T2 (`clientPhone`, `labels`), T3 (поля `edit`), T4 (`status:'delete'`), T5 (`notifyClient` в карточке).

**Files:**
- Modify: `frontend/js/pages/journal-card.js` (`jrClientPanel`, `jrStatusBar`, `jrAppointmentCard`, `jrRenderRecord`, `jrBindRecordEdit`; новые `JR_COLORS`, `jrCanReshape`, `jrPhoneHtml`, `jrExtraFields`, `jrCardEdit`, `jrDeleteRecord`, `jrRebook`)
- Modify: `frontend/js/pages/journal-forms.js` (`jrCreateClientPanel`, `jrLoadClients`, `jrForm`, `jrFormDraft`)
- Modify: `frontend/js/pages/journal-dispatch.js` (`jrReviewPending` — подписи действий)
- Modify: `frontend/css/journal.css`, `frontend/index.html` (бамп)
- Test: `backend/journal-ui.test.js`

Условия доступности (спека §4.1, совпадают с сервером из задач 3–4):
- комментарий, цвет, метки, технический перерыв, «не уведомлять» — `jrCanChange(r)` (не удалена, без оплаты, без блокирующего пакета), при любом статусе;
- длительность, смена клиента, удаление — `jrCanReshape(r)` = `jrCanChange(r) && r.attendance !== 1`;
- «Записать повторно» — у любой неудалённой записи.
Всё, что изменено в карточке, копится в `journal.session.edit` и уходит ОДНОЙ сессией по «Сохранить изменения» (или при закрытии — вопрос «Сохранить?», он уже работает через `jrUnsavedKind`). Удаление — отдельная форма подтверждения; несохранённые правки карточки уходят вместе с ним (`{status:'delete', edit}`).

Палитра (8 цветов + «без цвета»): `#f4a0a0`, `#ffad79`, `#f7c76d`, `#c5e384`, `#9ee5d7`, `#a8d8f0`, `#b3bdfd`, `#d7a6e8` — светлые тона в духе палитры статусов журнала. Точные hex-значения цветов YClients через API не опубликованы; если владелец пришлёт свои — правится одна константа `JR_COLORS`.

- [ ] **Step 1: Падающие тесты**

В конец `backend/journal-ui.test.js`:

```js
// ---- Card parity (12.11.2026) ----
const CARD = { id: 8, staffId: 1, staffName: 'Юлия', date: '2030-04-01', time: '09:15', duration: 60, clientName: 'Анна', clientPhone: '79200255591',
  attendance: 0, paid: false, services: [{ id: 900, title: 'Чистка', cost: 3000 }], comment: '', labels: [{ id: 3, title: '', color: '' }],
  customColor: '#f4a0a0', technicalBreak: 600, notifyClient: false };
const cardHarness = () => {
  const h = harness();
  h.run(`journal.data = {date:'2030-04-01',staff:[{id:1,name:'Юлия'}],services:[{id:70,yclientsId:900,title:'Чистка',staffIds:[1]}],labels:[{id:3,title:'<i>VIP</i>',color:'#ff0000'},{id:4,title:'Важно',color:'#00ff00'}]}`);
  return h;
};
test('card shows phone, editable comment, duration, break, palette, labels and the notify flag', () => {
  const h = cardHarness();
  const html = h.context.jrAppointmentCard(CARD);
  expect(html).toContain('<a href="tel:+79200255591">+79200255591</a>');
  expect(html).toContain('id="jrCopyPhone"');
  expect(html).toMatch(/<textarea id="jrCommentEdit" rows="4" maxlength="1000" placeholder="Комментарий не указан">/);
  expect(html).toMatch(/id="jrDurationEdit" type="number" min="5" max="720" step="5" value="60">/);
  expect(html).toContain('<option value="10" selected>10 мин</option>');
  expect((html.match(/data-color="/g) || []).length).toBe(9);
  expect(html).toContain('class="jr-color is-current" data-color="#f4a0a0"');
  expect(html).toContain('data-label="3" checked');
  expect(html).toContain('&lt;i&gt;VIP&lt;/i&gt;');
  expect(html).toContain('id="jrNoNotify" checked');
  expect(html).toContain('id="jrDelete"');
  expect(html).toContain('id="jrRebook"');
  expect(html).toContain('id="jrChangeClient"');
});
test('arrived unpaid visit: comment/colour editable; duration, client and delete are not', () => {
  const h = cardHarness();
  const html = h.context.jrAppointmentCard({ ...CARD, attendance: 1 });
  expect(html).toContain('<textarea id="jrCommentEdit" rows="4" maxlength="1000" placeholder="Комментарий не указан">');
  expect(html).toMatch(/id="jrDurationEdit"[^>]* disabled>/);
  expect(html).not.toContain('id="jrDelete"');
  expect(html).not.toContain('id="jrChangeClient"');
  const paid = h.context.jrAppointmentCard({ ...CARD, paid: true });
  expect(paid).toContain('<textarea id="jrCommentEdit" rows="4" maxlength="1000" placeholder="Комментарий не указан" readonly>');
});
test('card edits go into one session: comment, duration, break, colour, labels, notify', async () => {
  const h = cardHarness();
  h.context.jrRenderRecord({ ...CARD, notifyClient: true, customColor: null, labels: [] });
  h.get('jrCommentEdit').value = 'Позвонить'; h.get('jrCommentEdit').oninput();
  h.get('jrDurationEdit').value = '75'; h.get('jrDurationEdit').onchange();
  h.get('jrBreakEdit').value = '10'; h.get('jrBreakEdit').onchange();
  h.get('jrNoNotify').checked = true; h.get('jrNoNotify').onchange();
  h.context.jrCardEdit('customColor', '#f4a0a0');
  h.context.jrCardEdit('labelIds', [3]);
  expect(h.get('jrSaveChanges').disabled).toBe(false);
  h.context.jrApi = jest.fn().mockResolvedValue({ outboxId: 1, recordId: 8, status: 'queued' }); h.context.loadJournal = jest.fn();
  await h.get('jrSaveChanges').onclick();
  expect(h.context.jrApi).toHaveBeenCalledWith('sessions', expect.objectContaining({ recordId: 8,
    edit: { comment: 'Позвонить', seanceLength: 75, technicalBreak: 600, notifyClient: false, customColor: '#f4a0a0', labelIds: [3] } }));
});
test('an invalid duration is not put into the session', () => {
  const h = cardHarness();
  h.context.jrRenderRecord(CARD);
  h.get('jrDurationEdit').value = '7'; h.get('jrDurationEdit').onchange();
  expect(h.run('journal.session.edit')).toBeFalsy();
  expect(h.get('jrModalError').textContent).toContain('кратно 5');
});
test('change client: the card search picks a client into edit.client', () => {
  const h = cardHarness();
  h.context.jrRenderRecord(CARD);
  h.context.jrLoadClients = jest.fn();
  h.get('jrChangeClient').onclick();
  expect(h.get('jrChangeClientBox').hidden).toBe(false);
  const pick = h.context.jrLoadClients.mock.calls[0][1];
  pick({ name: '<b>Борис</b>', phone: '+79000000001' });
  expect(h.run('journal.session.edit.client')).toEqual({ name: '<b>Борис</b>', phone: '+79000000001' });
  expect(h.get('jrClientName').textContent).toContain('Борис');
  pick({ name: 'Без телефона', phone: '' });
  expect(h.get('jrModalError').textContent).toContain('нет телефона');
});
test('delete: own confirmation explains the difference from cancel; unsaved edits travel with it', async () => {
  const h = cardHarness();
  h.context.jrRenderRecord(CARD);
  h.context.jrCardEdit('notifyClient', true);
  h.context.jrDeleteRecord(CARD);
  expect(h.get('jrModalBody').innerHTML).toContain('отличие от отмены');
  h.context.jrApi = jest.fn().mockResolvedValue({ outboxId: 2, recordId: 8, status: 'queued' }); h.context.loadJournal = jest.fn();
  await h.get('jrApply').onclick();
  expect(h.context.jrApi).toHaveBeenCalledWith('sessions', { sessionId: 'synthetic-uuid-2', recordId: 8, status: 'delete', edit: { notifyClient: true } });
});
test('rebook opens the create form with the same client and services and no date', () => {
  const h = cardHarness();
  h.context.jrForm = jest.fn();
  h.context.jrRebook(CARD);
  expect(h.context.jrForm).toHaveBeenCalledWith(null, { staffId: 1, date: '', serviceIds: [70], client: { name: 'Анна', phone: '79200255591' } });
});
test('create form: «не уведомлять» goes into create.notifyClient', () => {
  const h = harness(); createForm(h);
  expect(h.context.jrFormDraft(null)).not.toHaveProperty('notifyClient');
  h.get('jrCreateNoNotify').checked = true;
  expect(h.context.jrFormDraft(null).notifyClient).toBe(false);
});
test('a record deleted locally says it waits for sending', () => {
  const h = harness();
  expect(h.context.jrStatusBar({ deleted: true, sync: { status: 'queued', released: false } })).toContain('Удалена (ждёт отправки)');
  expect(h.context.jrStatusBar({ deleted: true })).toContain('Запись удалена');
});
```

- [ ] **Step 2: Запустить — падают**

Run: `cd /root/loyalpro/backend && npx jest backend/journal-ui --silent`
Expected: FAIL — нет `tel:`, `jrCardEdit is not a function`, нет `jrCreateNoNotify`.

- [ ] **Step 3: `journal-card.js` — помощники**

В начало файла (после строки-заголовка) добавить:

```js
// Card parity with YClients (12.11.2026). Colour palette: one constant.
const JR_COLORS = ['#f4a0a0', '#ffad79', '#f7c76d', '#c5e384', '#9ee5d7', '#a8d8f0', '#b3bdfd', '#d7a6e8'];
function jrPhoneHtml(r) {
  const digits = String(r?.clientPhone || '').replace(/\D/g, '');
  if (!digits) return '<p class="jr-hint">Телефон не указан</p>';
  const tel = '+' + digits;
  return `<p class="jr-client-phone"><a href="tel:${jrEscape(tel)}">${jrEscape(tel)}</a><button type="button" class="btn btn-sec" id="jrCopyPhone" data-phone="${jrEscape(tel)}">Копировать</button></p>`;
}
function jrExtraFields(r) {
  const can = jrCanChange(r), reshape = jrCanReshape(r);
  const off = flag => (flag ? '' : ' disabled');
  const labels = journal.data?.labels || [];
  const chosen = new Set((r.labels || []).map(l => Number(l.id)));
  const pause = Math.round((Number(r.technicalBreak) || 0) / 60);
  return `<section class="jr-extra">
    <label class="jr-side-label">Длительность, мин<input id="jrDurationEdit" type="number" min="5" max="720" step="5" value="${jrEscape(r.duration)}"${off(reshape)}></label>
    <label class="jr-side-label">Технический перерыв<select id="jrBreakEdit"${off(can)}>${Array.from({ length: 13 }, (_, i) => i * 5).map(v => `<option value="${v}"${v === pause ? ' selected' : ''}>${v ? v + ' мин' : 'Нет'}</option>`).join('')}</select></label>
    <div class="jr-side-label">Цвет записи<div class="jr-colors" role="group" aria-label="Цвет записи"><button type="button" class="jr-color jr-color-none${r.customColor ? '' : ' is-current'}" data-color="" title="Без цвета"${off(can)}>∅</button>${JR_COLORS.map(c => `<button type="button" class="jr-color${r.customColor === c ? ' is-current' : ''}" data-color="${c}" style="background:${c}" title="${c}"${off(can)}></button>`).join('')}</div></div>
    <div class="jr-side-label">Метки${labels.length ? `<div class="jr-labels">${labels.map(l => `<label class="jr-label-choice"><input type="checkbox" data-label="${Number(l.id)}"${chosen.has(Number(l.id)) ? ' checked' : ''}${off(can)}><i class="jr-label-dot" style="background:${JR_HEX.test(l.color || '') ? l.color : '#999999'}"></i>${jrEscape(l.title)}</label>`).join('')}</div>` : '<p class="jr-hint">Меток в салоне нет.</p>'}</div>
    <label class="jr-notify"><input type="checkbox" id="jrNoNotify"${r.notifyClient === false ? ' checked' : ''}${off(can)}> Не уведомлять клиента</label>
  </section>`;
}
// One field of the card's session edit; enables «Сохранить изменения».
function jrCardEdit(key, value) {
  if (!journal.session) return;
  journal.session.edit ||= {};
  journal.session.edit[key] = value;
  jrEl('jrSaveChanges').disabled = false;
  // Cancel would contradict the draft (as for status/services edits).
  if (jrEl('jrCancel')) jrEl('jrCancel').disabled = true;
}
function jrDeleteRecord(r) {
  const carry = journal.session?.edit ? { ...journal.session.edit } : null;
  jrShowModal('Удалить запись');
  journal.draft = { action: 'delete', recordId: r.id };
  journal.session = jrNewSession({ recordId: r.id });
  journal.payment = null;
  jrEl('jrModalBody').innerHTML = `<p>${jrEscape(r.clientName)} · ${jrEscape(r.date)} ${jrEscape(r.time)}</p><p>Удалить запись насовсем? В отличие от отмены (статус «Не пришёл»), удалённая запись исчезнет из журнала, а после «Отправить в YClients» — и из YClients. Вернуть её будет нельзя.</p><div class="jr-actions"><button type="button" class="btn btn-pri jr-danger" id="jrApply">Да, удалить запись</button><button type="button" class="btn btn-sec" id="jrBack">Назад</button></div>`;
  jrEl('jrApply').onclick = () => jrSave({ sessionId: journal.session.sessionId, recordId: r.id, status: 'delete', ...(carry ? { edit: carry } : {}) });
  jrEl('jrBack').onclick = () => jrOpen(r.id);
}
// «Записать повторно»: the same client and services, the date is chosen anew.
function jrRebook(r) {
  const ids = new Set((r.services || []).map(s => Number(s.id)));
  const serviceIds = (journal.data?.services || []).filter(s => ids.has(Number(s.yclientsId)) && (s.staffIds || []).includes(r.staffId)).map(s => s.id);
  jrForm(null, { staffId: r.staffId, date: '', serviceIds, client: { name: r.clientName, phone: r.clientPhone || '' } });
}
```

Рядом с `const jrCanEdit = …` добавить:
```js
// Duration, client and deletion additionally exclude an arrived visit (spec §4.1).
const jrCanReshape = record => jrCanChange(record) && record.attendance !== 1;
```

- [ ] **Step 4: `journal-card.js` — разметка карточки**

`jrStatusBar`, первую строку тела
```js
  if (record?.deleted) return '<div class="jr-status-bar"><span class="jr-state-pill is-current">Запись удалена</span></div>';
```
заменить на
```js
  if (record?.deleted) return `<div class="jr-status-bar"><span class="jr-state-pill is-current">${['queued', 'running'].includes(record.sync?.status) ? 'Удалена (ждёт отправки)' : 'Запись удалена'}</span></div>`;
```

`jrClientPanel`: заголовок `function jrClientPanel(record, creating = false) {` → `function jrClientPanel(record, creating = false, editable = false) {`; строку
```js
    : `<div class="jr-client-identity">${jrIcon('user')}<h3>${jrEscape(record?.clientName || 'Клиент')}</h3></div>`}
    ${jrStub('Сменить клиента','user','jr-stub-inline')}
```
заменить на
```js
    : `<div class="jr-client-identity">${jrIcon('user')}<h3 id="jrClientName">${jrEscape(record?.clientName || 'Клиент')}</h3></div>${editable ? jrPhoneHtml(record) : ''}`}
    ${!creating && editable && record && jrCanReshape(record)
      ? `<button type="button" class="btn btn-sec" id="jrChangeClient">${jrIcon('user')} Сменить клиента</button><div id="jrChangeClientBox" class="jr-fields" hidden><label>Найти клиента<input id="jrClientSearch" type="search" placeholder="Имя или телефон" autocomplete="off"></label><h4 id="jrClientsTitle">Последние клиенты</h4><div id="jrClientResults" aria-live="polite"></div></div>`
      : jrStub('Сменить клиента','user','jr-stub-inline')}
```

`jrAppointmentCard` — три замены внутри возвращаемой строки:
1. `<label class="jr-side-label">Комментарий к записи<textarea rows="4" readonly placeholder="Комментарий не указан">${jrEscape(record.comment || '')}</textarea><small>Редактирование — скоро</small></label>${record ? jrTools() :`
   → `<label class="jr-side-label">Комментарий к записи<textarea id="jrCommentEdit" rows="4" maxlength="1000" placeholder="Комментарий не указан"${jrCanChange(record) ? '' : ' readonly'}>${jrEscape(record.comment || '')}</textarea></label>${jrExtraFields(record)}${record ? jrTools(record) :`
2. `</section>${jrClientPanel(record)}</div>` → `</section>${jrClientPanel(record, false, true)}</div>`
3. `${jrStub('Удалить запись','file','jr-stub-inline')}` → `${jrCanReshape(record) ? '<button type="button" class="btn btn-sec jr-danger" id="jrDelete">Удалить запись</button>' : ''}${record.deleted ? '' : '<button type="button" class="btn btn-sec" id="jrRebook">Записать повторно</button>'}`

`jrTools` пока принимает аргумент без использования: заголовок `function jrTools() {` → `function jrTools(record) {` (используется в задаче 13).

- [ ] **Step 5: `journal-card.js` — обработчики**

В `jrRenderRecord` перед закрывающей `}` функции добавить:

```js
    const copy = jrEl('jrCopyPhone');
    if (copy) copy.onclick = () => {
      const clip = typeof navigator !== 'undefined' && navigator.clipboard;
      (clip ? clip.writeText(copy.dataset?.phone || '') : Promise.reject(new Error('no clipboard')))
        .then(() => notify('Телефон скопирован.'))
        .catch(() => notify('Не удалось скопировать — выделите номер вручную.', 'err'));
    };
    if (jrCanReshape(r) && jrEl('jrDelete')) jrEl('jrDelete').onclick = () => jrDeleteRecord(r);
    if (!r.deleted && jrEl('jrRebook')) jrEl('jrRebook').onclick = () => jrRebook(r);
```

В `jrBindRecordEdit` сразу после строки `jrEl('jrSaveChanges').onclick = () => jrSave(jrSessionBody());` добавить:

```js
  // Parity fields (12.11.2026): each goes into the same session edit.
  const comment = jrEl('jrCommentEdit');
  if (comment) comment.oninput = () => jrCardEdit('comment', comment.value);
  const duration = jrEl('jrDurationEdit');
  if (duration && !duration.disabled) duration.onchange = () => {
    const n = Number(duration.value);
    if (!Number.isInteger(n) || n < 5 || n > 720 || n % 5 !== 0) { jrMessage('Длительность — от 5 до 720 минут, кратно 5.'); return; }
    jrMessage('');
    jrCardEdit('seanceLength', n);
  };
  const pause = jrEl('jrBreakEdit');
  if (pause) pause.onchange = () => jrCardEdit('technicalBreak', Number(pause.value) * 60);
  const noNotify = jrEl('jrNoNotify');
  if (noNotify) noNotify.onchange = () => jrCardEdit('notifyClient', !noNotify.checked);
  const body = jrEl('jrModalBody');
  body.querySelectorAll('[data-color]').forEach(b => { b.onclick = () => {
    jrCardEdit('customColor', b.dataset.color || null);
    body.querySelectorAll('[data-color]').forEach(x => x.classList?.toggle('is-current', x === b));
  }; });
  body.querySelectorAll('[data-label]').forEach(box => { box.onchange = () => {
    jrCardEdit('labelIds', Array.from(body.querySelectorAll('[data-label]')).filter(x => x.checked).map(x => Number(x.dataset.label)));
  }; });
  const pickClient = client => {
    if (!client?.phone) { jrMessage('У клиента нет телефона — выберите другого.'); return; }
    jrMessage('');
    jrCardEdit('client', { name: String(client.name || '').trim() || 'Без имени', phone: String(client.phone) });
    jrEl('jrChangeClientBox').hidden = true;
    jrEl('jrClientName').textContent = `${client.name || 'Без имени'} — заменит клиента после сохранения`;
  };
  const changeClient = jrEl('jrChangeClient');
  if (changeClient) changeClient.onclick = () => {
    jrEl('jrChangeClientBox').hidden = false;
    jrEl('jrClientSearch').oninput = () => jrLoadClients(jrEl('jrClientSearch').value.trim(), pickClient);
    jrLoadClients('', pickClient);
  };
```

Готча: в харнессе `jrEl(id)` всегда возвращает объект, а в браузере — `null`, поэтому каждая ручка проверяется на существование (`if (comment)`), прежде чем ей что-то присваивать.

- [ ] **Step 6: `journal-forms.js`**

`jrLoadClients`: заголовок `async function jrLoadClients(query = '') {` → `async function jrLoadClients(query = '', onPick = jrSelectClient) {`; строку
```js
    jrEl('jrClientResults').querySelectorAll('[data-client-index]').forEach(button => { button.onclick = () => jrSelectClient(journal.clientResults[Number(button.dataset.clientIndex)]); });
```
заменить на
```js
    jrEl('jrClientResults').querySelectorAll('[data-client-index]').forEach(button => { button.onclick = () => onPick(journal.clientResults[Number(button.dataset.clientIndex)]); });
```

`jrCreateClientPanel`: строку
```js
    </div><label class="jr-other-visitor"><input type="checkbox" disabled> Записывает другого посетителя <small>Скоро</small></label>
```
заменить на
```js
    </div><label class="jr-other-visitor"><input type="checkbox" disabled> Записывает другого посетителя <small>Скоро</small></label>
    <label class="jr-notify"><input type="checkbox" id="jrCreateNoNotify"> Не уведомлять клиента</label>
```

`jrForm`:
- строку `  jrEl('jrFormDate').value = record?.date || preset.date || jrEl('jrDate').value;` заменить на
```js
  // «Записать повторно» passes date:'' — the date is chosen anew.
  jrEl('jrFormDate').value = record?.date || (preset.date !== undefined ? preset.date : jrEl('jrDate').value);
```
- сразу после строки `  services();` (вызов, а не объявление) вставить:
```js
  if (!record && Array.isArray(preset.serviceIds) && preset.serviceIds.length) {
    for (const o of Array.from(jrEl('jrServices').options)) if (o) o.selected = preset.serviceIds.includes(Number(o.value));
    jrRenderServiceChoices();
  }
```
- в блоке `if (!record) {` после строки `    jrLoadClients();` вставить:
```js
    if (preset.client?.phone) jrSelectClient(preset.client);
```

`jrFormDraft`: фрагмент `comment: jrEl('jrComment').value });` заменить на `comment: jrEl('jrComment').value, ...(jrEl('jrCreateNoNotify')?.checked ? { notifyClient: false } : {}) });`

- [ ] **Step 7: `journal-dispatch.js`**

В `jrReviewPending` фрагмент `({create:'Создание',move:'Перенос',cancel:'Отмена',confirm:'Подтверждение'})` заменить на `({create:'Создание',move:'Перенос',cancel:'Отмена',confirm:'Подтверждение',edit:'Изменение',delete:'Удаление'})`.

- [ ] **Step 8: CSS и кэш**

В конец `frontend/css/journal.css`:

```css
/* Card parity fields (12.11.2026). */
.jr-extra{display:grid;gap:4px;margin:0 0 12px}
.jr-colors{display:flex;flex-wrap:wrap;gap:6px}
.jr-color{width:24px;height:24px;padding:0;border:2px solid transparent;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(0,0,0,.15);cursor:pointer}
.jr-color.is-current{border-color:var(--a)}
.jr-color-none{background:var(--card);color:var(--t3);font-size:12px;line-height:20px}
.jr-labels{display:grid;gap:4px}
.jr-label-choice,.jr-notify{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--t1,#222)}
.jr-label-choice input,.jr-notify input{width:auto}
.jr-client-phone{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0 10px}
.jr-client-phone a{font-weight:600;color:var(--a)}
.btn.jr-danger{color:var(--danger,#a64635);border-color:var(--danger,#a64635)}
```
Бамп: `journal-card.js`, `journal-forms.js`, `journal-dispatch.js` → `?v=t12-2026-11-12`; `css/journal.css?v=t11-2026-11-12` → `?v=t12-2026-11-12`.

- [ ] **Step 9: Зелёные**

Run: `npx jest backend/journal-ui --silent` → PASS (107 тестов).
Run: `npx jest backend/journal service-catalog finance bonus-ledger --silent` → зелёные.

Если падает старый тест `appointment card preserves real actions and exposes unavailable features as disabled placeholders`: он требует > 10 заглушек `class="jr-placeholder …"` — после задачи их 15 (8 в `jrTools`, «Чат», 5 инструментов клиента, «Товары»). Новые настоящие кнопки НЕ должны получать класс `jr-placeholder` (тест требует, чтобы каждая такая кнопка была `disabled`).

- [ ] **Step 10: Commit**

```bash
cd /root/loyalpro && git add frontend/js/pages/journal-card.js frontend/js/pages/journal-forms.js frontend/js/pages/journal-dispatch.js frontend/css/journal.css frontend/index.html backend/journal-ui.test.js && git commit -m "feat(journal): карточка — телефон, комментарий, длительность, смена клиента, цвет, метки, технический перерыв, «не уведомлять», удаление, «Записать повторно»

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 13: Карточка — история изменений и панель клиента

**Исполнитель:** Sonnet. **Зависимости:** T7 (`/records/:id/history`), T8 (`/clients/summary`), T12 (`jrClientPanel(record, creating, editable)`, `jrTools(record)`, `#jrClientName`).

**Files:**
- Modify: `frontend/js/pages/journal-card.js` (`jrTools`, `jrClientPanel`, `jrRenderRecord`; новые `jrHistoryHtml`, `jrLoadHistory`, `jrClientSummaryHtml`, `jrLoadClientSummary`)
- Modify: `frontend/css/journal.css`, `frontend/index.html` (бамп)
- Test: `backend/journal-ui.test.js`

Правила (спека §4.2, §4.4): история грузится по кнопке «История изменений» (лениво); панель клиента — при открытии карточки, один раз на открытие (перерисовка карточки опросом во время отправки берёт её из `journal.clientSummary`, а не дёргает сервер каждые 2 с). Ошибка панели — текст в самой панели, карточка работает. Без телефона панель не запрашивается вовсе (так же старые тесты с синтетическими записями без телефона не получают лишних вызовов `jrApi`).

Готча теста-заглушек: живая кнопка истории получает класс `jr-tool-live jr-placeholder` — именно в таком порядке: старый тест ищет `class="jr-placeholder…` (начало атрибута) и требует у каждой такой кнопки `disabled`. Стиль `.jr-placeholder` при этом применяется.

- [ ] **Step 1: Падающие тесты**

В конец `backend/journal-ui.test.js`:

```js
// ---- History and client panel (12.11.2026) ----
const SUMMARY = { name: 'Анна', phone: '79200255591', visits: { success: 7, fail: 2 }, bonusBalance: 650, loyaltyLevel: 'Золото', totalSpent: 42000,
  lastVisits: [{ date: '2026-11-01', staffName: '<b>Юлия</b>', services: ['Чистка'], attendance: 1 }], abonements: null, bonusesSource: 'card' };
test('card has a live history button and the client panel box', () => {
  const h = cardHarness();
  const html = h.context.jrAppointmentCard(CARD);
  expect(html).toContain('class="jr-tool-live jr-placeholder" id="jrHistoryOpen"');
  expect(html).toContain('<div id="jrHistory" class="jr-history-box" hidden></div>');
  expect(html).toContain('<div id="jrClientSummaryBox">');
  const move = h.context.jrClientPanel(CARD);   // the move form keeps the old placeholder panel
  expect(move).not.toContain('jrClientSummaryBox');
});
test('history: lazy load, escaped changes, package errors, empty state', async () => {
  const h = cardHarness();
  h.context.jrApi = jest.fn().mockResolvedValue({ recordId: 8, events: [
    { at: '2026-11-12T07:10:00Z', source: 'yclients', author: 'YClients', title: 'Изменена в YClients', changes: [{ field: 'comment', label: 'Комментарий', from: null, to: '<script>x</script>' }] },
    { at: '2026-11-12T07:07:00Z', source: 'journal', author: 'LoyalPro: Мария', title: 'перенос — ошибка', changes: [], error: 'Время занято' },
  ] });
  await h.context.jrLoadHistory(8);
  expect(h.context.jrApi).toHaveBeenCalledWith('records/8/history');
  const html = h.get('jrHistory').innerHTML;
  expect(h.get('jrHistory').hidden).toBe(false);
  expect(html).toContain('Комментарий: — → &lt;script&gt;x&lt;/script&gt;');
  expect(html).toContain('LoyalPro: Мария');
  expect(html).toContain('Время занято');
  expect(html).toContain('12.11, 10:10');
  expect(h.context.jrHistoryHtml([])).toContain('Изменений пока нет');
  h.context.jrApi = jest.fn().mockRejectedValue(new Error('Нет связи'));
  await h.context.jrLoadHistory(8);
  expect(h.get('jrHistory').innerHTML).toContain('Нет связи');
});
test('client panel: visits, no-shows, bonuses, abonements unreadable, last visits escaped', () => {
  const h = harness();
  const html = h.context.jrClientSummaryHtml(SUMMARY);
  for (const s of ['Визитов<span>7</span>', 'Неявок<span>2</span>', 'Бонусы<span>650</span>', 'Уровень<span>Золото</span>', 'Абонементы: не удалось прочитать']) expect(html).toContain(s);
  expect(html).toContain('&lt;b&gt;Юлия&lt;/b&gt;');
  expect(h.context.jrClientSummaryHtml({ ...SUMMARY, abonements: [] })).toContain('Абонементов нет');
  expect(h.context.jrClientSummaryHtml({ ...SUMMARY, abonements: [{ title: 'Чистка ×5', balance: 3, expires: '2027-01-01T00:00:00' }] })).toContain('Чистка ×5 · осталось 3 · до 2027-01-01');
});
test('client panel loads once per opened card; failure stays inside the panel', async () => {
  const h = cardHarness();
  h.context.jrApi = jest.fn().mockResolvedValue(SUMMARY);
  await h.context.jrLoadClientSummary(CARD);
  await h.context.jrLoadClientSummary(CARD);
  expect(h.context.jrApi).toHaveBeenCalledTimes(1);
  expect(h.context.jrApi).toHaveBeenCalledWith('clients/summary?phone=79200255591');
  expect(h.get('jrClientSummaryBox').innerHTML).toContain('Визитов<span>7</span>');
  h.run('journal.modalRequest++');
  h.context.jrApi = jest.fn().mockRejectedValue(new Error('YClients недоступен'));
  await h.context.jrLoadClientSummary(CARD);
  expect(h.get('jrClientSummaryBox').innerHTML).toContain('Не удалось загрузить данные клиента: YClients недоступен');
});
test('no phone: the panel says so and does not call the server', async () => {
  const h = cardHarness();
  h.context.jrApi = jest.fn();
  await h.context.jrLoadClientSummary({ ...CARD, clientPhone: '' });
  expect(h.context.jrApi).not.toHaveBeenCalled();
  expect(h.get('jrClientSummaryBox').innerHTML).toContain('Телефон клиента неизвестен');
});
```

- [ ] **Step 2: Запустить — падают**

Run: `cd /root/loyalpro/backend && npx jest backend/journal-ui --silent`
Expected: FAIL — нет `jrHistoryOpen`, `jrLoadHistory is not a function`.

- [ ] **Step 3: Реализация в `journal-card.js`**

Функцию `jrTools` заменить на:

```js
function jrTools(record) {
  const live = !!record && record.id != null;
  return `<div class="jr-tools">${[['ЕГИСЗ','plus'],['Текущий приём','file'],['Расширенные поля','list'],['Повторение записи','repeat'],['Уведомления о визите','bell'],['Списание расходников','box'],['История изменений','clock'],['Лист назначения','file']].map(([title,icon]) => live && title === 'История изменений'
    ? `<button type="button" class="jr-tool-live jr-placeholder" id="jrHistoryOpen">${jrIcon(icon)}<span>${title}</span></button>`
    : jrStub(title,icon)).join('')}</div>${live ? '<div id="jrHistory" class="jr-history-box" hidden></div>' : ''}`;
}
```

В `jrClientPanel` строку
```js
    <section class="jr-client-info"><h4>Статистика</h4><div class="jr-client-stats"><p>Последний визит<span>—</span></p><p>Всего визитов<span>—</span></p></div><small>Данные карточки клиента пока не подключены к журналу.</small></section>
```
заменить на
```js
    ${editable ? '<section class="jr-client-info"><h4>Клиент</h4><div id="jrClientSummaryBox"><p class="jr-hint">Загрузка данных клиента…</p></div></section>'
      : '<section class="jr-client-info"><h4>Статистика</h4><div class="jr-client-stats"><p>Последний визит<span>—</span></p><p>Всего визитов<span>—</span></p></div><small>Данные карточки клиента пока не подключены к журналу.</small></section>'}
```

В конец файла добавить:

```js
// ---- History of changes (spec §4.2) and client panel (§4.4) ----
const jrMskStamp = iso => new Date(iso).toLocaleString('ru', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function jrHistoryHtml(events) {
  if (!events?.length) return '<p class="jr-hint">Изменений пока нет. Журнал вебхуков YClients ведётся с 04.11.2026.</p>';
  return `<ol class="jr-history">${events.map(e => `<li><div class="jr-history-head"><time>${jrEscape(jrMskStamp(e.at))}</time><strong>${jrEscape(e.author)}</strong><span>${jrEscape(e.title)}</span></div>${(e.changes || []).length ? `<ul>${e.changes.map(c => `<li>${jrEscape(c.label)}: ${jrEscape(c.from ?? '—')} → ${jrEscape(c.to ?? '—')}</li>`).join('')}</ul>` : ''}${e.error ? `<p class="jr-sync-failed-note">${jrEscape(e.error)}</p>` : ''}</li>`).join('')}</ol>`;
}
async function jrLoadHistory(id) {
  const box = jrEl('jrHistory'), request = journal.modalRequest;
  box.hidden = false;
  box.innerHTML = '<p class="jr-hint">Загрузка истории…</p>';
  try {
    const data = await jrApi(`records/${encodeURIComponent(id)}/history`);
    if (request === journal.modalRequest) jrEl('jrHistory').innerHTML = jrHistoryHtml(data.events);
  } catch (e) {
    if (request === journal.modalRequest) jrEl('jrHistory').innerHTML = `<p class="jr-hint">${jrEscape(e.message)}</p>`;
  }
}
function jrClientSummaryHtml(s) {
  if (!s) return '<p class="jr-hint">Нет данных клиента.</p>';
  const v = value => jrEscape(value ?? '—');
  const abonements = s.abonements === null || s.abonements === undefined ? '<p class="jr-hint">Абонементы: не удалось прочитать.</p>'
    : s.abonements.length ? `<ul class="jr-abonements">${s.abonements.map(a => `<li>${jrEscape(a.title)}${a.balance != null ? ' · осталось ' + jrEscape(a.balance) : ''}${a.expires ? ' · до ' + jrEscape(String(a.expires).slice(0, 10)) : ''}</li>`).join('')}</ul>`
    : '<p class="jr-hint">Абонементов нет.</p>';
  const last = (s.lastVisits || []).length ? `<h4>Последние визиты</h4><ul class="jr-last-visits">${s.lastVisits.map(x => `<li>${jrEscape(x.date)} · ${jrEscape(x.staffName)} · ${jrEscape((x.services || []).join(', '))} · ${jrEscape(jrStatus({ attendance: x.attendance }))}</li>`).join('')}</ul>` : '';
  return `<div class="jr-client-stats"><p>Визитов<span>${v(s.visits?.success)}</span></p><p>Неявок<span>${v(s.visits?.fail)}</span></p><p>Бонусы<span>${v(s.bonusBalance)}</span></p><p>Уровень<span>${v(s.loyaltyLevel)}</span></p><p>Потрачено<span>${s.totalSpent == null ? '—' : jrEscape(Number(s.totalSpent).toLocaleString('ru-RU') + ' ₽')}</span></p></div>${abonements}${last}`;
}
async function jrLoadClientSummary(r) {
  const box = jrEl('jrClientSummaryBox');
  if (!box) return;
  const phone = String(r?.clientPhone || '').replace(/\D/g, '');
  if (!phone) { box.innerHTML = '<p class="jr-hint">Телефон клиента неизвестен — данных нет.</p>'; return; }
  const request = journal.modalRequest;
  const cached = journal.clientSummary;
  if (cached && cached.phone === phone && cached.request === request) { box.innerHTML = cached.html; return; }
  box.innerHTML = '<p class="jr-hint">Загрузка данных клиента…</p>';
  try {
    const s = await jrApi('clients/summary?' + new URLSearchParams({ phone }));
    if (request !== journal.modalRequest) return;
    const html = jrClientSummaryHtml(s);
    journal.clientSummary = { phone, request, html };
    const now = jrEl('jrClientSummaryBox');
    if (now) now.innerHTML = html;
  } catch (e) {
    if (request !== journal.modalRequest) return;
    const now = jrEl('jrClientSummaryBox');
    if (now) now.innerHTML = `<p class="jr-hint">Не удалось загрузить данные клиента: ${jrEscape(e.message)}</p>`;
  }
}
```

В `jrRenderRecord` перед закрывающей `}` функции добавить:
```js
    const history = jrEl('jrHistoryOpen');
    if (history) history.onclick = () => jrLoadHistory(r.id);
    // Lazy, once per opened card; errors stay inside the panel.
    jrLoadClientSummary(r);
```

Проверка времени в тесте: `2026-11-12T07:10:00Z` по Москве — `12.11, 10:10` (формат `toLocaleString('ru', {day, month, hour, minute})` даёт «12.11, 10:10»).

- [ ] **Step 4: CSS и кэш**

В конец `frontend/css/journal.css`:

```css
/* History and client panel (12.11.2026). */
.jr-placeholder.jr-tool-live{cursor:pointer;color:var(--t1,#222)}
.jr-history-box{margin:0 0 16px;max-height:320px;overflow:auto;font-size:12px}
.jr-history-box[hidden]{display:none}
.jr-history{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.jr-history>li{padding:8px;border:1px solid var(--bd);border-radius:8px}
.jr-history-head{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline}
.jr-history-head time{color:var(--t3)}
.jr-history ul,.jr-last-visits,.jr-abonements{margin:4px 0 0;padding-left:16px;font-size:12px}
```
Бамп: `journal-card.js?v=t12-2026-11-12` → `?v=t13-2026-11-12`, `css/journal.css?v=t12-2026-11-12` → `?v=t13-2026-11-12`.

- [ ] **Step 5: Зелёные**

Run: `npx jest backend/journal-ui --silent` → PASS (112 тестов).
Run: `npx jest backend/journal service-catalog finance bonus-ledger --silent` → зелёные.

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add frontend/js/pages/journal-card.js frontend/css/journal.css frontend/index.html backend/journal-ui.test.js && git commit -m "feat(journal): история изменений записи и панель клиента в карточке

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 14: Браузерная проверка `backend/scripts/journal-ui-e2e.js` и живой прогон на деве

**Исполнитель:** Sonnet (скрипт), старшая модель или человек (живой прогон §«Живой прогон»). **Зависимости:** все предыдущие.

**Files:**
- Create: `backend/scripts/journal-ui-e2e.js`

Скрипт ничего не пишет в YClients и не создаёт пакетов: все диалоги подтверждения ОТКЛОНЯЮТСЯ, карточка закрывается без изменений, а любой не-GET запрос к `/api/journal/` считается провалом. В дев-БД пишется только строка `sessions` для токена (удаляется в `finally`). Образец — `backend/scripts/economics-pay-ui-e2e.js`.

- [ ] **Step 1: Написать скрипт**

Создать `backend/scripts/journal-ui-e2e.js`:

```js
'use strict';
// ============================================================
// Живая проверка журнала записи (паритет с YClients v1, спека
// docs/superpowers/specs/2026-11-12-journal-parity-v1-design.md §7) против
// ЗАПУЩЕННОГО дев-сервера: headless-Chrome, владелец салона, свежий токен.
//
//   node scripts/journal-ui-e2e.js
//
//   1. День с записями: сетка, значки/цвет/метки видны, скриншоты обеих тем.
//   2. «Неделя»: 7 колонок одного мастера; «День» обратно.
//   3. Календарь месяца: дни с точками загрузки.
//   4. Перетаскивание блока: появляется вопрос «Перенести…»/«Длительность…»
//      (или отказ сетки), диалог ОТКЛОНЯЕТСЯ — ничего не сохраняется.
//   5. Карточка: поля паритета на месте, история грузится, панель клиента есть;
//      закрытие без изменений не спрашивает «Сохранить?».
//   6. Телефон 390px: один мастер, чипы, кнопки «Неделя» нет.
//   7. Печать (emulateMediaType('print')): тулбар скрыт.
// Скриншоты: /tmp/journal-*.png. Ни одного не-GET запроса к /api/journal/.
// ============================================================
require('dotenv').config();
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const config = require('../config');
const { db } = require('../db');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3001';
const UA = 'journal-ui-e2e';
const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const skip = (m) => console.log('  \x1b[33m–\x1b[0m ' + m);
const fail = (m) => { throw new Error(m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const user = await db.oneOrNone(`SELECT id, salon_id, role FROM users WHERE role = 'owner' ORDER BY id LIMIT 1`);
  if (!user) fail('нет владельца в базе');
  // A future day with an unpaid, not-arrived visit: there is something to drag.
  const day = await db.oneOrNone(`SELECT to_char(visit_date,'YYYY-MM-DD') AS d FROM records
    WHERE salon_id = $1 AND visit_date > (now() AT TIME ZONE 'Europe/Moscow')::date AND COALESCE(status,'') <> 'deleted'
      AND COALESCE(raw_payload->>'attendance','0') IN ('0','2') AND COALESCE(raw_payload->>'paid_full','0') = '0'
    ORDER BY visit_date LIMIT 1`, [user.salon_id]);
  const date = day ? day.d : new Date(Date.now() + 3 * 3600e3 + 86400e3).toISOString().slice(0, 10);
  const token = jwt.sign({ userId: user.id, salonId: user.salon_id, role: user.role }, config.JWT_SECRET, { expiresIn: '15m' });
  await db.query(`INSERT INTO sessions (user_id, token, ip, user_agent, expires_at) VALUES ($1, $2, '127.0.0.1', $3, NOW() + INTERVAL '15 minutes')`, [user.id, token, UA]);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'], executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' });
  const errors = [], writes = [], dialogs = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.evaluateOnNewDocument((t) => localStorage.setItem('lp_tk', t), token);
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });   // NEVER confirm: nothing is saved
    page.on('request', r => { if (r.method() !== 'GET' && /\/api\/journal\//.test(r.url())) writes.push(`${r.method()} ${r.url().replace(/^.*\/api/, '/api')}`); });

    const showDay = async () => {
      await page.evaluate((d) => { jrEl('jrDate').value = d; return loadJournal(); }, date);
      await page.waitForFunction(() => document.querySelector('#jrGrid .jr-calendar, #jrGrid .jr-empty'), { timeout: 30000 });
    };
    await page.goto(BASE + '/#journal', { waitUntil: 'networkidle2' });
    await page.waitForSelector('#jrGrid', { timeout: 20000 });
    await showDay();

    // 1. Day, both themes.
    const columns = await page.$$eval('#jrGrid .jr-column', e => e.length);
    if (!columns) fail(`на ${date} нет колонок мастеров`);
    ok(`день ${date}: колонок ${columns}, записей ${await page.$$eval('#jrGrid .jr-visit', e => e.length)}, перерывов ${await page.$$eval('#jrGrid .jr-cell-break', e => e.length)}`);
    await page.screenshot({ path: '/tmp/journal-day-light.png', fullPage: true });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await sleep(300);
    await page.screenshot({ path: '/tmp/journal-day-dark.png', fullPage: true });
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    ok('скриншоты /tmp/journal-day-{light,dark}.png');

    // 2. Week.
    await page.click('#jrViewWeek');
    await page.waitForFunction(() => document.querySelectorAll('#jrGrid .jr-week .jr-column').length === 7, { timeout: 30000 });
    await page.screenshot({ path: '/tmp/journal-week.png', fullPage: true });
    ok('неделя: 7 колонок, /tmp/journal-week.png');
    await page.click('#jrViewDay');
    await page.waitForFunction(() => !document.querySelector('#jrGrid .jr-week'), { timeout: 30000 });

    // 3. Month calendar.
    await page.click('#jrMonthBtn');
    await page.waitForFunction(() => document.querySelectorAll('#jrMonth .jr-month-day').length >= 28, { timeout: 30000 });
    const dots = await page.$$eval('#jrMonth .jr-density', e => e.filter(x => x.textContent.length > 0).length);
    await page.screenshot({ path: '/tmp/journal-month.png' });
    ok(`календарь месяца: дней с точками загрузки ${dots}, /tmp/journal-month.png`);
    await page.click('#jrMonth [data-month-close]');

    // 4. Drag with a dismissed confirmation.
    const block = await page.$('#jrGrid .jr-visit.jr-draggable');
    if (!block) skip(`на ${date} нет перетаскиваемых записей — шаг перетаскивания пропущен`);
    else {
      const box = await block.boundingBox();
      const x = box.x + box.width / 2, y = box.y + Math.min(12, box.height / 2);
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(x, y + i * 10);   // +100 px ≈ +60 мин
      await page.mouse.up();
      await sleep(500);
      const notif = await page.$eval('#notif', e => e.textContent).catch(() => '');
      const asked = dialogs.find(m => /^Перенести запись|^Длительность/.test(m));
      if (asked) ok(`перетаскивание: вопрос «${asked}» — отклонён`);
      else if (notif) ok(`перетаскивание: сетка отказала («${notif.trim()}»)`);
      else fail('перетаскивание не дало ни вопроса, ни отказа');
      if (writes.length) fail('после отклонённого вопроса ушли запросы: ' + writes.join(', '));
      ok('после отклонения ничего не сохранено');
      await showDay();
    }

    // 5. Card.
    const visit = await page.$('#jrGrid .jr-visit');
    if (!visit) skip('записей нет — карточка не проверялась');
    else {
      await visit.click();
      await page.waitForSelector('#jrModal[open] #jrCommentEdit', { timeout: 30000 });
      const present = await page.evaluate(() => ['jrDurationEdit', 'jrBreakEdit', 'jrNoNotify', 'jrRebook', 'jrHistoryOpen', 'jrClientSummaryBox']
        .filter(id => !document.getElementById(id)));
      if (present.length) fail('в карточке нет: ' + present.join(', '));
      if (!(await page.$('#jrModal .jr-colors'))) fail('в карточке нет палитры цвета');
      ok('карточка: длительность, перерыв, цвет, «не уведомлять», «Записать повторно», история, панель клиента');
      await page.click('#jrHistoryOpen');
      await page.waitForFunction(() => { const h = document.getElementById('jrHistory'); return h && !h.hidden && !/Загрузка/.test(h.textContent); }, { timeout: 30000 });
      ok('история: ' + (await page.$eval('#jrHistory', e => e.textContent.trim().slice(0, 80))));
      await page.waitForFunction(() => !/Загрузка/.test(document.getElementById('jrClientSummaryBox')?.textContent || ''), { timeout: 30000 });
      ok('панель клиента: ' + (await page.$eval('#jrClientSummaryBox', e => e.textContent.trim().slice(0, 80))));
      await page.screenshot({ path: '/tmp/journal-card.png' });
      await page.click('#jrModal .jr-dialog-head button');
      await sleep(300);
      if (await page.$eval('#jrModal', m => m.open)) fail('карточка без изменений не закрылась (спросила «Сохранить?»)');
      ok('карточка закрыта без вопроса, /tmp/journal-card.png');
    }

    // 6. Phone 390px.
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await sleep(400);
    await showDay();
    const mobile = await page.evaluate(() => ({
      columns: document.querySelectorAll('#jrGrid .jr-column').length,
      chips: !document.getElementById('jrStaffChips').hidden,
      week: getComputedStyle(document.getElementById('jrViewWeek')).display,
    }));
    if (mobile.columns !== 1) fail('на 390px колонок ' + mobile.columns);
    if (mobile.week !== 'none') fail('на 390px видна кнопка «Неделя»');
    await page.screenshot({ path: '/tmp/journal-mobile.png', fullPage: true });
    ok(`телефон 390px: 1 колонка, чипы мастеров ${mobile.chips ? 'есть' : 'нет (один мастер)'}, /tmp/journal-mobile.png`);

    // 7. Print.
    await page.setViewport({ width: 1400, height: 900 });
    await sleep(400);
    await showDay();
    await page.emulateMediaType('print');
    const toolbar = await page.$eval('.jr-toolbar', e => getComputedStyle(e).display);
    if (toolbar !== 'none') fail('при печати тулбар виден');
    await page.screenshot({ path: '/tmp/journal-print.png', fullPage: true });
    await page.emulateMediaType(null);
    ok('печать: тулбар скрыт, /tmp/journal-print.png');

    if (writes.length) fail('не-GET запросы к журналу: ' + writes.join(', '));
    ok('не-GET запросов к /api/journal/ не было');
    if (errors.length) fail('ошибки в консоли браузера:\n' + errors.join('\n'));
    ok('ошибок в консоли браузера нет');
  } finally {
    await browser.close();
    await db.query(`DELETE FROM sessions WHERE user_agent = $1`, [UA]).catch(() => {});
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('\x1b[31mFAIL\x1b[0m', e.message); process.exit(1); });
```

- [ ] **Step 2: Прогнать на деве**

Run:
```bash
cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 5 && node scripts/journal-ui-e2e.js
```
Expected: все строки с «✓» (допустимы «–» про пропуск перетаскивания/карточки, если на деве нет подходящих записей), в конце процесс выходит с кодом 0. Открыть скриншоты `/tmp/journal-day-light.png`, `/tmp/journal-day-dark.png`, `/tmp/journal-week.png`, `/tmp/journal-month.png`, `/tmp/journal-card.png`, `/tmp/journal-mobile.png`, `/tmp/journal-print.png` и глазами проверить: блоки не налезают, текст на тёмной теме читается, на 390px карточка мастера не шире экрана.

Если скрипт падает на шаге — это дефект соответствующей задачи (9–13): чинить там, с тестом в `journal-ui.test.js`, и перезапускать скрипт.

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro && git add backend/scripts/journal-ui-e2e.js && git commit -m "test(journal): браузерная проверка паритета журнала (день, неделя, календарь, перетаскивание, карточка, 390px, печать)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Живой прогон на деве (спека §7) — выполняет старшая модель или человек

Правила: тестовые записи — ТОЛЬКО клиент 79200255591, с уборкой; модуль уведомлений на деве в режиме `off` или `shadow` с этим номером в пилотном списке (живым пациентам ничего не уходит); перед началом записать текущий режим (`SELECT mode, pilot_phones FROM notification_settings WHERE salon_id=1` через MCP postgres) и вернуть его в конце.

1. Включить для прогона режим `shadow` с пилотным номером 79200255591 (если не включён) — так job'ы будут ставиться и их статусы видны в `notification_jobs`.
2. В журнале на деве создать запись клиенту 79200255591 на завтра, отметить «Не уведомлять клиента» в форме создания, сохранить. «Отправить в YClients» за завтрашний день. Проверить:
   - `SELECT status, steps FROM journal_outbox WHERE salon_id=1 ORDER BY id DESC LIMIT 1` — `done`, шаг `create` с `params.notifyClient=false`;
   - `SELECT * FROM journal_record_prefs WHERE salon_id=1 ORDER BY updated_at DESC LIMIT 1` — `notify_client=false`;
   - `SELECT status, decision_reason, trigger_type FROM notification_jobs WHERE yclients_record_id=<id> ORDER BY id` — все `skipped`, `journal_opt_out`;
   - в `webhook_logs` вебхук `create` этой записи несёт `data.api_id = '<id пакета>'` (числом).
3. Открыть карточку: телефон, «Копировать». Изменить комментарий, цвет (любой из палитры), поставить метку, длительность +15 мин, технический перерыв 10 мин; «Сохранить изменения» → «Отправить в YClients». Сверить запись в YClients `GET /record/{cid}/{id}` (через `node -e` с `services/journal/yclients.getRecord`): `comment`, `custom_color` (записать, в каком виде вернулся: с `#` или без), `record_labels`, `seance_length`, `technical_break_duration`.
4. Перенести эту же запись перетаскиванием на +1 час (подтвердить) → отправить → снова `GET /record`: цвет, метки и перерыв СОХРАНИЛИСЬ (проверка `recordExtras`, задача 3b). Если YClients их стёр или вернул 4xx на `record_labels` из чисел — записать это как дефект, формат правит задача 3b.
5. Снять «Не уведомлять» → сохранить → отправить: строка `journal_record_prefs.notify_client=true`; следующий вебхук этой записи ставит job'ы как обычно.
6. «Удалить запись» → подтвердить → отправить: шаг `delete` `done`, в `journal_operations` строка `action='delete'`, `GET /record` → `deleted:true` (или 404), запись исчезла из сетки; повторная отправка того же пакета (если был `failed`) — `done` без повторного `DELETE`.
7. Вернуть режим уведомлений и пилотный список в исходное состояние; убедиться, что в YClients у клиента 79200255591 не осталось тестовых записей.
8. Итог прогона (что сверено, формат `custom_color`, ответ YClients на `record_labels`) — дописать в раздел «Журнал записи» `CLAUDE.md` одним абзацем.

---

## Самопроверка плана

1. **Покрытие спеки по разделам.**
   - §1 Включено/сетка: неделя — T6, T10; календарь с загрузкой — T6, T10; перетаскивание и растягивание — T3a (явная длительность), T11; цвет и метки — T2, T9; значки 🌐 ✦ 💳 💬 — T2, T9; перерывы и технический перерыв — T2 (занятость), T9 (ячейки и полоса); печать — T9; мобильный день — T10. ✔
   - §1 Включено/карточка: телефон — T2, T12; комментарий, длительность, смена клиента, цвет, метки, технический перерыв — T3, T12; «не уведомлять» — T3 (`create.notifyClient`), T5, T12; удаление — T4, T12; «Записать повторно» — T12; история — T7, T13; панель клиента — T8, T13. ✔
   - §2 Разрезание фронта, один `vm`, `?v=` у каждого файла — T1 (+бампы в T9–T13). ✔
   - §3.1–3.3 — T6, T9, T10, T11 (ограничения перетаскивания — `jrDragAllowed`). ✔ Отступление: текст подтверждения «к специалисту Юлия» вместо «к Юлии» (склонение имён не делаем) — оговорено в T11.
   - §4.1 таблица и условия правки — T3 (сервер), T12 (клиент: `jrCanChange`/`jrCanReshape`). ✔ Наложение новых полей и «удалена (ждёт отправки)» — T3c, T4, T12. ✔
   - §4.2 история — T7, T13. ✔ §4.3 уведомления — T4 (`api_id`), T5. ✔ §4.4 панель клиента — T8, T13. ✔
   - §5 сервер: `parseSession`/`buildSteps` — T3c, T4; `record-edit` — T3b; воркер `delete` и prefs — T4, T5; `normalizeRecord` — T2; `reference-cache` labels — T2; маршруты — T6, T7, T8; миграция — T5. Отступление: кроме `journal_record_prefs`, в T4 расширяется CHECK `journal_operations.action` (иначе шаг `delete` не запишется в аудит `mutate`). ✔
   - §6 крайние случаи: `busy`/`slot_taken` при перетаскивании — T11 (`jrDragSave`); удаление с оплатой — T4 (409); смена клиента онлайн-записи — не запрещается (проверок по `online` нет); `DELETE` уже удалённой — T4; удалённая метка → 4xx → `failed` — штатное поведение воркера (`classify` → `fail`), отдельного кода нет; история с 04.11 — текст пустого состояния T13. ✔
   - §7 проверка — jest во всех задачах, `journal-ui` на всех файлах (T1), `scripts/journal-ui-e2e.js` (T14), живой прогон — раздел выше. ✔
   - Не покрыто: `backfillReminders` флаг «не уведомлять» не смотрит (обоснование в T5); `client.is_new` и `success_visits_count` в данных дева не проверены живьём — если YClients их не присылает, значок ✦ просто не появится, а панель клиента посчитает визиты по `records`.
2. **Скан заглушек.** Просмотрены все шаги: в каждом шаге с кодом — сам код; «TBD», «аналогично», «добавить обработку ошибок» не используются; команды запуска и ожидаемый результат указаны в каждом шаге «Запустить». ✔
3. **Согласованность имён.** Сервер: `edit.{comment, seanceLength, client, customColor, labelIds, technicalBreak, notifyClient}` (T3b) = тела сессий фронта (T11 `edit.seanceLength`, T12 `jrCardEdit` ключи) = параметры шага в воркере (T5 `p.notifyClient`). Наложение `patch.{comment, client, custom_color, record_labels, technical_break_duration, notify_client, deleted}` (T3c, T4) = поля, читаемые `normalizeRecord` (T2) и `detail` (`r.notify_client`, T5). `index.availability` draft `durationOverride`/`technicalBreak` (T3a) = вызовы в `record-edit.patch` (T3b) и `sessions.validate` (T3c). `mutate(salonId, userId, draft, opts)` / `prepare(salon, draft, opts)` с `opts.apiId` (T4) = вызов воркера `{ apiId: prefs.apiIdFor(<id>) } (числовой id пакета, поправка 13.11.2026)` (T4) = `record-prefs.API_ID` (T5). Фронт: `jrColumnHtml`, `jrBounds`, `jrHourLabels`, `jrBindGrid`, `jrOccupied`, `JR_HEX` (T9) используются в T10, T11, T12; `JR_MOBILE_MAX`, `jrIsMobile`, `journal.week`, `journal.view` (T10) — в T11; `jrClientPanel(record, creating, editable)`, `jrTools(record)`, `#jrClientName` (T12) — в T13. Ответы `GET /week` (`staff`, `days[].records/workRanges`), `GET /month` (`days[].density`), `/records/:id/history` (`events[].author/title/changes/error`), `/clients/summary` (`visits`, `bonusBalance`, `abonements`, `lastVisits`) совпадают в серверных задачах и фронтовых тестах. ✔
