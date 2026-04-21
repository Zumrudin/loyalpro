# ТЗ: Топ услуг → Таблица со сортировкой

## Обзор
Преобразовать "Топ услуг" из прогресс-баров в **интерактивную таблицу с 3 колонками и сортировкой**.

---

## Требования

### Фронтенд
**Файл:** `frontend/js/pages/dashboard.js`  
**Функция:** `buildTopSvc(svcs)` → переделать полностью

**Что нужно:**
1. Таблица с 3 колонками:
   - **Услуга** (название) — сортируемая
   - **Количество** (cnt) — сортируемая
   - **Сумма** (total_amount) — сортируемая, форматировать как деньги (₽)

2. Сортировка:
   - Кликаем на заголовок → сортируем по этой колонке
   - Повторный клик → реверсируем сортировку (ASC/DESC)
   - Иконка сортировки (▲▼⇅) как в таблице клиентов

3. Стили:
   - Использовать существующие .th-sort, .sort-icon из base.css
   - Таблица в контейнере с классом `.tw` (table-wrapper)
   - Никакой пагинации (показываем все услуги)

**Пример HTML структуры (как образец):**
```html
<div class="tw">
  <table>
    <thead>
      <tr>
        <th class="th-sort asc" onclick="svcSort('service_name')" data-col="service_name">
          <span>Услуга</span><i class="sort-icon"></i>
        </th>
        <th class="th-sort" onclick="svcSort('cnt')" data-col="cnt">
          <span>Количество</span><i class="sort-icon"></i>
        </th>
        <th class="th-sort" onclick="svcSort('total_amount')" data-col="total_amount">
          <span>Сумма</span><i class="sort-icon"></i>
        </th>
      </tr>
    </thead>
    <tbody id="svcBody">...</tbody>
  </table>
</div>
```

**JavaScript логика:**
- Глобальная переменная `svcData = []` для хранения данных
- Глобальная переменная `svcSortCol = 'cnt'`, `svcSortDir = 'desc'` (по умолчанию сортируем по количеству DESC)
- Функция `svcSort(column)` — переключает сортировку и перерисовывает таблицу
- При клике переделать tbody и обновить иконки сортировки

**Форматирование:**
- Количество: просто число (1, 10, 100)
- Сумма: форматировать как `parseFloat().toLocaleString('ru') + ' ₽'`

---

### Бэкенд
**Файл:** `backend/routes/api.js`  
**Строка:** 112  
**Функция:** `/analytics/dashboard`

**Что менять:**

1. **Удалить LIMIT 8** — выводить ВСЕ услуги:
```sql
-- Старое:
... ORDER BY cnt DESC LIMIT 8

-- Новое:
... ORDER BY svc->>'title' ASC LIMIT 100000
```
*(100000 — это просто большой лимит, на практике будет меньше)*

2. **Убедиться что total_amount есть в SELECT:**
```sql
SELECT 
  svc->>'title' as service_name, 
  COUNT(DISTINCT r.id) as cnt,                    -- ✅ уже исправлено
  SUM((svc->>'cost_to_pay')::numeric) as total_amount  -- ✅ убедись что есть
FROM ...
```

3. **Результат должен быть:**
```json
{
  "service_name": "Стрижка",
  "cnt": 45,
  "total_amount": "15450.00"
}
```

---

## HTML структура в index.html
**Текущий код (строка 142):**
```html
<div class="card"><div class="ct">Топ услуг</div><div id="topSvc"><div class="empty">Нет данных</div></div></div>
```

**Нужно изменить на:**
```html
<div class="card" style="padding:0">
  <div class="ct" style="padding:18px 18px 0 18px">Топ услуг</div>
  <div class="tw"><table>
    <thead>
      <tr>
        <th class="th-sort asc" onclick="svcSort('service_name')" data-col="service_name">
          <span>Услуга</span><i class="sort-icon"></i>
        </th>
        <th class="th-sort" onclick="svcSort('cnt')" data-col="cnt">
          <span>Количество</span><i class="sort-icon"></i>
        </th>
        <th class="th-sort" onclick="svcSort('total_amount')" data-col="total_amount">
          <span>Сумма ₽</span><i class="sort-icon"></i>
        </th>
      </tr>
    </thead>
    <tbody id="svcBody"><tr><td colspan="3" class="empty">Нет данных</td></tr></tbody>
  </table></div>
</div>
```

---

## Функции в dashboard.js

### 1. `buildTopSvc(svcs)` — инициализация
```javascript
function buildTopSvc(svcs) {
  if (!svcs?.length) {
    document.getElementById('svcBody').innerHTML = '<tr><td colspan="3" class="empty">Нет данных</td></tr>';
    return;
  }
  svcData = svcs.slice();  // Копируем данные
  svcSortCol = 'cnt';
  svcSortDir = 'desc';
  renderSvcTable();
}
```

### 2. `svcSort(column)` — обработчик сортировки
```javascript
function svcSort(column) {
  const headers = document.querySelectorAll('#page-dashboard table th.th-sort');
  headers.forEach(h => h.classList.remove('asc', 'desc'));
  
  if (svcSortCol === column) {
    svcSortDir = svcSortDir === 'asc' ? 'desc' : 'asc';  // Переключаем
  } else {
    svcSortCol = column;
    svcSortDir = column === 'service_name' ? 'asc' : 'desc';  // По названию ASC по умолчанию
  }
  
  // Подсветить текущий header
  const header = document.querySelector(`[data-col="${svcSortCol}"]`);
  if (header) header.classList.add(svcSortDir);
  
  renderSvcTable();
}
```

### 3. `renderSvcTable()` — отрисовка таблицы
```javascript
function renderSvcTable() {
  // Сортируем копию данных
  const sorted = svcData.slice().sort((a, b) => {
    let aVal = a[svcSortCol];
    let bVal = b[svcSortCol];
    
    if (svcSortCol !== 'service_name') {
      aVal = parseFloat(aVal) || 0;
      bVal = parseFloat(bVal) || 0;
    }
    
    return svcSortDir === 'asc' ? 
      (typeof aVal === 'string' ? aVal.localeCompare(bVal) : aVal - bVal) :
      (typeof aVal === 'string' ? bVal.localeCompare(aVal) : bVal - aVal);
  });
  
  // Отрисовываем tbody
  const tbody = document.getElementById('svcBody');
  tbody.innerHTML = sorted.map(s => `
    <tr>
      <td>${s.service_name || '—'}</td>
      <td><strong>${s.cnt}</strong></td>
      <td>${parseFloat(s.total_amount || 0).toLocaleString('ru')} ₽</td>
    </tr>
  `).join('');
}
```

### 4. Глобальные переменные (в начале файла)
```javascript
let svcData = [];
let svcSortCol = 'cnt';
let svcSortDir = 'desc';
```

---

## Проверка
1. Дашборд загружается → "Топ услуг" отображается таблицей
2. Таблица показывает ВСЕ услуги (не только 8)
3. Кликаем на "Услуга" → сортирует по названию (ASC)
4. Кликаем на "Количество" → сортирует по cnt (DESC)
5. Кликаем на "Сумма ₽" → сортирует по total_amount (DESC)
6. Повторный клик → реверсирует сортировку (стрелка меняется ▲↔▼)
7. Числа форматированы правильно (1450,50 ₽ или 1 450,50 ₽)

---

## Резюме

| Компонент | Файл | Действие |
|-----------|------|---------|
| **Бэкенд** | backend/routes/api.js:112 | Удалить LIMIT 8, убедиться total_amount есть |
| **HTML** | frontend/index.html:142 | Заменить div с прогресс-барами на таблицу |
| **JS** | frontend/js/pages/dashboard.js | Добавить svcSort(), renderSvcTable(), переделать buildTopSvc() |
| **CSS** | frontend/css/base.css | Уже готовы стили (.th-sort, .tw, table) |

**Сложность:** 🟡 Средняя  
**Время:** ~30 мин  
**Риск:** Низкий (только UI изменения)
