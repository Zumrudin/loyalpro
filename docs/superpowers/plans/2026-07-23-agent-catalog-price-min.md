# План: каталог агента теряет «от»-услуги (фильтр по price_max) — фикс

> Debugging root cause (доказано на живых данных PERI CLINIC, company 668791):
> `ycGetServiceCatalog` (`backend/services/yclients.js:287`) фильтрует `Number(s.price_max) > 0`.
> Но услуги со стартовой ценой «от X» хранят цену в `price_min`, а `price_max=0`.
> Пример: «Ноги полностью» price_min=5000, price_max=0 → выпадала. Все 43 зоны
> «Лазерной эпиляции» имеют `price_min>0`. Новый критерий `price_min>0 || price_max>0`
> проходит 316/318 услуг (+85), отсекает ровно 2 мусорных (min=max=0: «еуые»,
> «Запрет на отправку»), добавляет 0 новых active=1 (агент по умолчанию их не видит —
> гейт decideOfferVisible прячет active=0).

**Goal:** восстановить «от»-услуги в каталоге агента (админ-страница «услуги агента» и tool list_services), корректно показывать/называть стартовую цену.

**Tech Stack:** Node.js, Jest, vanilla JS frontend.

---

### Task 1: Фильтр каталога по наличию любой цены

**Files:**
- Modify: `backend/services/yclients.js` (строка 287 + экспорт хелпера)
- Test: `backend/yclients-service-catalog.test.js` (новый)

- [ ] **Step 1: Failing-тест на чистый предикат `hasAnyPrice`**

Создать `backend/yclients-service-catalog.test.js`:
```js
'use strict';
const { hasAnyPrice } = require('./services/yclients');

describe('hasAnyPrice — услуга имеет цену (для фильтра каталога)', () => {
  test('стартовая цена «от X»: price_min>0, price_max=0 → true (раньше терялась)', () => {
    expect(hasAnyPrice({ price_min: 5000, price_max: 0 })).toBe(true);
  });
  test('обычный диапазон: price_max>0 → true', () => {
    expect(hasAnyPrice({ price_min: 0, price_max: 3000 })).toBe(true);
  });
  test('фикс. цена: price_min==price_max>0 → true', () => {
    expect(hasAnyPrice({ price_min: 1430, price_max: 1430 })).toBe(true);
  });
  test('нет цены нигде: min=max=0 → false (мусор отсекается)', () => {
    expect(hasAnyPrice({ price_min: 0, price_max: 0 })).toBe(false);
  });
  test('нечисловые/отсутствующие поля → false', () => {
    expect(hasAnyPrice({})).toBe(false);
    expect(hasAnyPrice({ price_min: null, price_max: undefined })).toBe(false);
  });
});
```

- [ ] **Step 2: Прогнать — падает (нет экспорта hasAnyPrice)**

Run: `cd /root/loyalpro/backend && npx jest yclients-service-catalog`
Expected: FAIL — `hasAnyPrice is not a function`.

- [ ] **Step 3: Реализовать хелпер и применить в фильтре**

В `backend/services/yclients.js`:
- Рядом с `ycGetServiceCatalog` (перед ней) добавить:
```js
// price_max=0 — валидный признак «от price_min» (стартовая цена без верхней
// границы). Фильтровать только по price_max нельзя — так теряются все «от»-услуги.
const hasAnyPrice = s => Number(s && s.price_min) > 0 || Number(s && s.price_max) > 0;
```
- Заменить строку 287:
```js
  const priced = (Array.isArray(catalog) ? catalog : []).filter(s => Number(s.price_max) > 0);
```
на:
```js
  const priced = (Array.isArray(catalog) ? catalog : []).filter(hasAnyPrice);
```
- В `module.exports` добавить `hasAnyPrice` к экспортам (в объект где уже `ycGetServiceCatalog, clearServiceCatalogCache, ycGetServiceMeta`).

- [ ] **Step 4: Прогнать — зелёно**

Run: `cd /root/loyalpro/backend && npx jest yclients-service-catalog`
Expected: PASS (5 тестов).

- [ ] **Step 5: Регрессия — агентские тесты не задеты (они мокают ycGetServiceCatalog целиком)**

Run: `cd /root/loyalpro/backend && npx jest agent-tools agent-booking-modify`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
cd /root/loyalpro && git add backend/services/yclients.js backend/yclients-service-catalog.test.js && git commit -m "fix(agent): каталог не терял услуги со стартовой ценой «от X»

ycGetServiceCatalog фильтровал price_max>0, но у услуг «от X» цена лежит
в price_min (price_max=0 = без верхней границы). Из-за этого ~85 реальных
услуг (все зоны лазерной эпиляции) не попадали ни в админ-список услуг
агента, ни в list_services. Фильтр теперь по наличию любой цены
(price_min||price_max), мусор без цены (min=max=0) по-прежнему отсекается.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Админ-фронт показывает стартовую цену «от X»

**Files:**
- Modify: `frontend/js/pages/agent-services-catalog.js` (функция `_price`, ~строка 105)

- [ ] **Step 1: Заменить `_price`**

Текущее:
```js
function _price(s) {
  if (!(Number(s.price_max) > 0)) return '';
  return String(s.price_min) === String(s.price_max)
    ? `${s.price_min} ₽` : `${s.price_min}–${s.price_max} ₽`;
}
```
на:
```js
function _price(s) {
  const min = Number(s.price_min) || 0, max = Number(s.price_max) || 0;
  if (max > 0) {
    return String(min) === String(max) ? `${min} ₽` : `${min}–${max} ₽`;
  }
  if (min > 0) return `от ${min} ₽`;   // price_max=0 — стартовая цена без верхней границы
  return '';
}
```

- [ ] **Step 2: Проверить логику функции изолированно (нет фронт-харнесса)**

Run:
```bash
node -e "
const _price = (s) => { const min=Number(s.price_min)||0,max=Number(s.price_max)||0; if(max>0){return String(min)===String(max)?min+' RUB':min+'-'+max+' RUB';} if(min>0)return 'ot '+min+' RUB'; return ''; };
console.log(JSON.stringify([
  _price({price_min:5000,price_max:0}),   // ot 5000
  _price({price_min:1430,price_max:1430}),// 1430
  _price({price_min:0,price_max:3000}),   // 0-3000
  _price({price_min:0,price_max:0}),      // ''
]));
"
```
Expected: `["ot 5000 RUB","1430 RUB","0-3000 RUB",""]`

- [ ] **Step 3: Commit**
```bash
cd /root/loyalpro && git add frontend/js/pages/agent-services-catalog.js && git commit -m "fix(agent-ui): показывать стартовую цену «от X ₽» для услуг без верхней границы

price_max=0 у услуги «от X» больше не даёт пустую цену — рисуем «от {price_min} ₽».

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Промпт — трактовка price_max=0 как стартовой цены

**Files:**
- Modify: `backend/services/agent/system-prompt.js` (после бублета «ЦЕНА ЗАВИСИТ ОТ МАСТЕРА…»)
- Test: `backend/agent-system-prompt.test.js`

- [ ] **Step 1: Failing guard-тест**

В `backend/agent-system-prompt.test.js`, рядом с другими проверками содержимого промпта (тем же способом получения текста `p`), добавить:
```js
  test('промпт объясняет стартовую цену price_max=0 → «от X»', () => {
    expect(p).toContain('стартовая цена без верхней границы');
  });
```
(Если в файле текст промпта получается не через переменную `p`, использовать тот же механизм, что и соседние ассерты.)

- [ ] **Step 2: Прогнать — падает**

Run: `cd /root/loyalpro/backend && npx jest agent-system-prompt`
Expected: FAIL на новом тесте.

- [ ] **Step 3: Добавить правило в `system-prompt.js`**

Сразу ПОСЛЕ бублета, заканчивающегося `...Называй факт цены, без домыслов.`, вставить новый элемент массива:
```js
    `СТАРТОВАЯ ЦЕНА «ОТ». Если у услуги price_max равен 0 (или отсутствует), а price_min задан — это стартовая цена без верхней границы: называй «от {price_min} ₽» (например price_min:5000, price_max:0 → «от 5 000 ₽»). Не выдавай такую цену за точную и не показывай диапазон вида «5000–0».`,
```

- [ ] **Step 4: Прогнать промпт-тесты — зелёно**

Run: `cd /root/loyalpro/backend && npx jest agent-system-prompt`
Expected: PASS (33 теста).

- [ ] **Step 5: Commit**
```bash
cd /root/loyalpro && git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js && git commit -m "feat(agent): Мила называет стартовую цену «от X» при price_max=0

Услуги со стартовой ценой (price_max=0, price_min>0) агент теперь называет
как «от {price_min} ₽», а не точной ценой и не сломанным диапазоном.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Полный прогон

- [ ] **Step 1:** `cd /root/loyalpro/backend && npx jest yclients-service-catalog agent-tools agent-system-prompt agent-slots-staff-check agent-booking` → всё зелёное.
