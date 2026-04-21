# Доработка: Топ услуг → Таблица со сортировкой

## Задача
Преобразовать "Топ услуг" из прогресс-баров в таблицу с сортировкой.

## Результат
3 колонки с интерактивной сортировкой:
- **Услуга** (название)
- **Количество** (cnt) ← считает уникальные записи
- **Сумма** (total_amount) ← форматировать как деньги (1 450,50 ₽)

## Что менять

### 1️⃣ Бэкенд: `backend/routes/api.js` строка 112
```javascript
// Старое:
... ORDER BY cnt DESC LIMIT 8

// Новое:
... ORDER BY svc->>'title' ASC LIMIT 100000
```
Убедиться что в SELECT есть `SUM((svc->>'cost_to_pay')::numeric) as total_amount`

### 2️⃣ HTML: `frontend/index.html` строка 142
Заменить:
```html
<div class="card"><div class="ct">Топ услуг</div><div id="topSvc">...</div></div>
```

На:
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

### 3️⃣ JS: `frontend/js/pages/dashboard.js`
**В начало файла добавить:**
```javascript
let svcData = [];
let svcSortCol = 'cnt';
let svcSortDir = 'desc';
```

**Функция `buildTopSvc(svcs)` — переделать на:**
```javascript
function buildTopSvc(svcs) {
  if (!svcs?.length) {
    document.getElementById('svcBody').innerHTML = '<tr><td colspan="3" class="empty">Нет данных</td></tr>';
    return;
  }
  svcData = svcs.slice();
  svcSortCol = 'cnt';
  svcSortDir = 'desc';
  renderSvcTable();
}
```

**Добавить функцию `svcSort(column)` (обработчик клика на заголовок):**
```javascript
function svcSort(column) {
  const headers = document.querySelectorAll('#page-dashboard table th.th-sort');
  headers.forEach(h => h.classList.remove('asc', 'desc'));
  
  if (svcSortCol === column) {
    svcSortDir = svcSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    svcSortCol = column;
    svcSortDir = column === 'service_name' ? 'asc' : 'desc';
  }
  
  const header = document.querySelector(`[data-col="${svcSortCol}"]`);
  if (header) header.classList.add(svcSortDir);
  
  renderSvcTable();
}
```

**Добавить функцию `renderSvcTable()` (отрисовка таблицы):**
```javascript
function renderSvcTable() {
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

## Проверка
✓ Таблица показывает все услуги (не LIMIT 8)  
✓ Кликаем на заголовок → сортирует  
✓ Повторный клик → реверсирует (▲↔▼)  
✓ Сумма форматирована (1 450,50 ₽)

## Примечание
После изменений **перезагрузить браузер и перезапустить сервис**
