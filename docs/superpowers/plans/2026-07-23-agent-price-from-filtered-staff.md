# План: цена/длительность услуги агента — только по отфильтрованным мастерам

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `list_services` должен считать цену и диапазон услуги ТОЛЬКО по мастерам, реально её выполняющим (после deny-пар «страницы агента»), убрать сырой диапазон из каталога YClients, добавить длительность услуги и скрывать услуги без исполнителей.

**Architecture:** Правим один чистый тул `backend/services/agent/tools/list-services.js`: агрегат цены строим из `staffOf(s)` вместо `s.price_min/s.price_max`; длительность тянем из `ycGetServiceMeta` (service-level, секунды→минуты); услуга без мастеров после фильтра отбрасывается. Плюс одна строка в system-prompt против выдуманных причин разницы цен.

**Tech Stack:** Node.js, Jest. Спек: `docs/superpowers/specs/2026-07-23-agent-price-from-filtered-staff-design.md`.

---

### Task 1: Цена из отфильтрованных мастеров + длительность в `list_services`

**Files:**
- Modify: `backend/services/agent/tools/list-services.js`
- Test: `backend/agent-tools.test.js` (блок `describe('list_services')`, строки 88-191; мок yclients стр. 5; импорт стр. 22; beforeEach стр. 55-60)

- [ ] **Step 1: Добавить мок `ycGetServiceMeta` в тест-инфраструктуру**

В `backend/agent-tools.test.js` заменить строку 5:
```js
jest.mock('./services/yclients', () => ({ ycGet: jest.fn(), ycGetServiceCatalog: jest.fn() }));
```
на:
```js
jest.mock('./services/yclients', () => ({ ycGet: jest.fn(), ycGetServiceCatalog: jest.fn(), ycGetServiceMeta: jest.fn() }));
```

Заменить строку 22:
```js
const { ycGet, ycGetServiceCatalog } = require('./services/yclients');
```
на:
```js
const { ycGet, ycGetServiceCatalog, ycGetServiceMeta } = require('./services/yclients');
```

В `beforeEach` (после строки 59, внутри блока) добавить дефолт, чтобы услуги без явной меты давали `duration_min: null`:
```js
  ycGetServiceMeta.mockResolvedValue({ durationByService: new Map(), resourceIdsByService: new Map() });
```

- [ ] **Step 2: Обновить существующий exact-match тест под новое поле `duration_min`**

В `agent-tools.test.js` тест «активные услуги + достоверные мастера…» (стр. 103-108) заменить ожидаемый объект на (добавлено `duration_min: null`; цены-агрегаты `5000/8000` совпадают со старыми, т.к. равны диапазону мастеров):
```js
    expect(out.services).toEqual([
      { yc_id: 7, title: 'Ботулинотерапия', duration_min: null, price_min: 5000, price_max: 8000, staff: [
        { yc_id: 55, name: 'Аня', price_min: 5000, price_max: 5000 },
        { yc_id: 66, name: 'Пери', price_min: 8000, price_max: 8000 },
      ] },
    ]);
```

- [ ] **Step 3: Добавить новые тесты (репро бага + скрытие + длительность)**

В `agent-tools.test.js` внутри `describe('list_services', …)`, перед закрывающей `});` блока (стр. 191), вставить три теста:
```js
  test('«теневой» мастер (deny-пара) не влияет на цену — диапазон только по реальным исполнителям', async () => {
    db.any
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ yclients_staff_id: 5, name: 'Аня' }, { yclients_staff_id: 6, name: 'Пери' }]);
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetServiceCatalog.mockResolvedValue(catalog(
      [{ id: 7, title: 'Ноги полностью', price_min: 5000, price_max: 21000, active: 1 }],
      { 7: [5, 6] },
      // Аня реально делает за 5000; у Пери в YClients есть доступ за 21000, но по факту не делает
      { 7: { 5: { price_min: 5000, price_max: 5000 }, 6: { price_min: 21000, price_max: 21000 } } }));
    settings.loadServiceFilterSafe.mockResolvedValue({
      mode: 'all', denyServices: new Set(), allowServices: new Set(), denyPairs: new Set(['7:6']),
    });
    const out = await listServices.run(1, {});
    expect(out.services[0].staff.map(s => s.name)).toEqual(['Аня']);
    expect(out.services[0].price_min).toBe(5000);
    expect(out.services[0].price_max).toBe(5000);   // 21000 «теневого» мастера ушёл из диапазона
  });

  test('услуга без исполнителей после deny-пар не показывается', async () => {
    db.any
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ yclients_staff_id: 5, name: 'Аня' }]);
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetServiceCatalog.mockResolvedValue(catalog(
      [{ id: 7, title: 'Только на усмотрение врача', price_min: 9000, price_max: 9000, active: 1 }],
      { 7: [5] }));
    settings.loadServiceFilterSafe.mockResolvedValue({
      mode: 'all', denyServices: new Set(), allowServices: new Set(), denyPairs: new Set(['7:5']),
    });
    const out = await listServices.run(1, {});
    expect(out.services).toEqual([]);
  });

  test('duration_min прокидывается из меты (секунды → минуты)', async () => {
    db.any
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ yclients_staff_id: 5, name: 'Аня' }]);
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetServiceCatalog.mockResolvedValue(catalog(
      [{ id: 7, title: 'Пилинг', price_min: 4000, price_max: 4000, active: 1 }],
      { 7: [5] }));
    ycGetServiceMeta.mockResolvedValue({ durationByService: new Map([['7', 1800]]), resourceIdsByService: new Map() });
    const out = await listServices.run(1, {});
    expect(out.services[0].duration_min).toBe(30);   // 1800 сек → 30 мин
  });
```

- [ ] **Step 4: Прогнать тесты — убедиться, что новые падают**

Run: `cd backend && npx jest agent-tools -t "list_services"`
Expected: FAIL — «теневой» тест ждёт `price_max` 5000, но текущий код отдаёт service-level 21000; тест длительности падает на `undefined` (нет поля `duration_min`); exact-match тест падает на отсутствии `duration_min`.

- [ ] **Step 5: Реализовать изменения в `list-services.js`**

В `backend/services/agent/tools/list-services.js` заменить строку 4:
```js
const { ycGetServiceCatalog } = require('../../yclients');
```
на:
```js
const { ycGetServiceCatalog, ycGetServiceMeta } = require('../../yclients');
```

Заменить блок загрузки каталога (строки 39-47):
```js
  let priced = [], staffIdsByService = new Map(), staffPricesByService = new Map();
  if (salon && salon.yclients_company_id) {
    try {
      const cat = await ycGetServiceCatalog(salon, staffRows.map(r => r.yclients_staff_id));
      priced = cat.priced;
      staffIdsByService = cat.staffIdsByService;
      staffPricesByService = cat.staffPricesByService || new Map();
    } catch (_) { /* YClients недоступен → фолбэк на заголовки из конфига */ }
  }
```
на (добавлена загрузка длительностей отдельным вызовом с собственным catch — сбой меты не должен ронять список услуг в фолбэк):
```js
  let priced = [], staffIdsByService = new Map(), staffPricesByService = new Map();
  let durationByService = new Map();
  if (salon && salon.yclients_company_id) {
    try {
      const cat = await ycGetServiceCatalog(salon, staffRows.map(r => r.yclients_staff_id));
      priced = cat.priced;
      staffIdsByService = cat.staffIdsByService;
      staffPricesByService = cat.staffPricesByService || new Map();
    } catch (_) { /* YClients недоступен → фолбэк на заголовки из конфига */ }
    // Длительность услуги (service-level): per-staff длительности в YClients нет.
    const meta = await ycGetServiceMeta(salon).catch(() => null);
    durationByService = (meta && meta.durationByService) || new Map();
  }
```

Заменить блок формирования `services` (строки 72-92):
```js
  let services;
  if (priced.length) {
    services = priced
      .filter(s => svcFilter.decideOfferVisible(filter, s.id, s.active === 1))
      .map(s => ({
        yc_id: s.id,
        title: s.title,
        price_min: s.price_min,
        price_max: s.price_max,
        staff: staffOf(s),   // мастера с ценой каждого: [{name, price_min, price_max}]
      }));
  } else {
    // Нет живых данных (нет YClients-компании или API упал) → отдаём хотя бы заголовки из конфига.
    services = cfg.map(c => ({
      yc_id: c.yclients_service_id,
      title: c.service_title,
      price_min: null,
      price_max: null,
      staff: [],
    }));
  }
```
на:
```js
  let services;
  if (priced.length) {
    services = priced
      .filter(s => svcFilter.decideOfferVisible(filter, s.id, s.active === 1))
      .map(s => {
        const staff = staffOf(s);   // только реальные исполнители (минус deny-пары), с ценой каждого
        const dur = durationByService.get(String(s.id));
        return {
          yc_id: s.id,
          title: s.title,
          duration_min: dur ? Math.round(dur / 60) : null,
          // Диапазон цены — АГРЕГАТ по отфильтрованным мастерам, а НЕ сырой диапазон
          // каталога YClients (тот включал бы «теневых» мастеров без реальной услуги).
          price_min: staff.length ? Math.min(...staff.map(m => m.price_min)) : null,
          price_max: staff.length ? Math.max(...staff.map(m => m.price_max)) : null,
          staff,
        };
      })
      .filter(s => s.staff.length > 0);   // услуга без исполнителей после deny-пар не предлагается
  } else {
    // Нет живых данных (нет YClients-компании или API упал) → отдаём хотя бы заголовки из конфига.
    services = cfg.map(c => ({
      yc_id: c.yclients_service_id,
      title: c.service_title,
      duration_min: null,
      price_min: null,
      price_max: null,
      staff: [],
    }));
  }
```

- [ ] **Step 6: Прогнать тесты — убедиться, что проходят**

Run: `cd backend && npx jest agent-tools`
Expected: PASS — весь файл `agent-tools.test.js` зелёный (включая три новых теста и обновлённый exact-match).

- [ ] **Step 7: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/tools/list-services.js backend/agent-tools.test.js && git commit -m "fix(agent): цена/длительность услуги только по отфильтрованным мастерам

Диапазон цены услуги считается агрегатом по мастерам, реально её
выполняющим (после deny-пар «страницы агента»), а не по сырому каталогу
YClients — это устраняет «прыгающую» цену (теневой мастер с доступом,
но не делающий услугу, тащил свой price_max в диапазон). Услуга без
исполнителей после фильтра больше не предлагается. Добавлена длительность
услуги (service-level из ycGetServiceMeta, секунды→минуты).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Промпт — запрет выдумывать причину разницы цен

**Files:**
- Modify: `backend/services/agent/system-prompt.js:109`
- Test: `backend/agent-system-prompt.test.js` (промпт защищён тестами — прогон обязателен)

- [ ] **Step 1: Дополнить правило о цене**

В `backend/services/agent/system-prompt.js` заменить строку 109:
```js
    `ЦЕНА ЗАВИСИТ ОТ МАСТЕРА. Когда спрашивают стоимость — обязательно сверь цены мастеров в поле staff. Если у всех цена одинаковая — назови одну. Если различается — назови по мастерам: «у специалиста Ивановой — 3 000 ₽, у главного врача Петровой — 5 000 ₽».`,
```
на:
```js
    `ЦЕНА ЗАВИСИТ ОТ МАСТЕРА. Когда спрашивают стоимость — обязательно сверь цены мастеров в поле staff. Если у всех цена одинаковая — назови одну. Если различается — назови по мастерам: «у специалиста Ивановой — 3 000 ₽, у главного врача Петровой — 5 000 ₽». НИКОГДА не выдумывай причину разницы цен (не «мужская/женская», не «аппарат мощнее», не «дольше по времени») — причина только в разных мастерах. Называй факт цены, без домыслов.`,
```

- [ ] **Step 2: Прогнать тесты промпта**

Run: `cd backend && npx jest agent-system-prompt`
Expected: PASS — тесты промпта зелёные (проверка, что упоминается `list_services` и структура промпта не поломана).

- [ ] **Step 3: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/system-prompt.js && git commit -m "fix(agent): запрет выдумывать причину разницы цен между мастерами

Мила галлюцинировала объяснение разброса цен («мужская/женская
эпиляция»). Причина разницы — только разные мастера; домыслы про
свойства процедуры запрещены.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Полный прогон тестов агента

**Files:** нет (проверка)

- [ ] **Step 1: Прогнать все тесты, затронутые list-services/промптом**

Run: `cd backend && npx jest agent-tools agent-system-prompt agent-slots-staff-check agent-booking`
Expected: PASS — все четыре набора зелёные (убеждаемся, что моки и косвенные пользователи `list_services` не сломаны).

- [ ] **Step 2: Верификация поведения (по возможности live)**

Если есть доступ к живому YClients для тестового салона PERI CLINIC — вызвать `list_services` и убедиться, что «ноги полностью» отдаёт `price_min=price_max=5000`, а поля с 21 000 в данных модели нет. Если live-доступа нет — зафиксировать это явно и опереться на юнит-репро из Task 1 Step 3.
```

