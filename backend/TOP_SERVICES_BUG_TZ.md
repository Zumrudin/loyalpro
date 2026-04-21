# ТЗ: Исправление подсчета "Топ услуг" на дашборде

## Проблема

На дашборде в блоке "Топ услуг" счёт услуг **неправильный**.

**Текущее поведение:**
- Если в одной записи 3 услуги → каждая услуга считается как 1
- Это приводит к завышению COUNT для услуг

**Правильное поведение (YClients):**
- COUNT = количество **записей**, в которых была эта услуга
- Если запись содержит услугу "Стрижка" И "Укладка" → обе услуги считают по 1 в COUNT каждая, но это ОДНА запись, а не две

---

## Технические детали

### Текущая логика (НЕПРАВИЛЬНАЯ)
**Файл:** `backend/routes/api.js:112`

```sql
SELECT svc->>'title' as service_name, 
       COUNT(*) as cnt,                              -- ❌ ПРОБЛЕМА: считает строки JSON, не записи
       SUM((svc->>'cost_to_pay')::numeric) as total_amount
FROM records r, jsonb_array_elements(COALESCE(r.services,'[]'::jsonb)) svc
WHERE r.salon_id=$1 
  AND r.status IN ('completed','confirmed') 
  AND r.visit_date>=NOW()-INTERVAL '${days} days' 
  AND svc->>'title' IS NOT NULL 
GROUP BY svc->>'title' 
ORDER BY cnt DESC LIMIT 8
```

**Проблема:**
- `jsonb_array_elements()` распаковывает каждый элемент массива в отдельную строку
- `COUNT(*)` считает эти строки, а не уникальные записи
- Пример: запись с 3 услугами → 3 строки в результате → каждая услуга в COUNT представляет эту запись как 1

### Правильная логика (ЧТО НУЖНО)

```sql
SELECT svc->>'title' as service_name, 
       COUNT(DISTINCT r.id) as cnt,                  -- ✅ Считаем уникальные записи
       SUM((svc->>'cost_to_pay')::numeric) as total_amount
FROM records r, jsonb_array_elements(COALESCE(r.services,'[]'::jsonb)) svc
WHERE r.salon_id=$1 
  AND r.status IN ('completed','confirmed') 
  AND r.visit_date>=NOW()-INTERVAL '${days} days' 
  AND svc->>'title' IS NOT NULL 
GROUP BY svc->>'title' 
ORDER BY cnt DESC LIMIT 8
```

**Изменение:**
- `COUNT(*)` → `COUNT(DISTINCT r.id)` ✅ теперь считаем ЗАПИСИ, а не услуги в JSON

---

## Пример с реальными данными

### Сценарий: 3 записи в выбранный период

| record.id | services (JSON array) |
|-----------|----------------------|
| 1         | [{title: "Стрижка", ...}, {title: "Укладка", ...}] |
| 2         | [{title: "Стрижка", ...}] |
| 3         | [{title: "Массаж", ...}, {title: "Стрижка", ...}] |

### Неправильный подсчет (текущий код):
```
Стрижка:  COUNT(*) = 3  ❌ (строки JSON, не записи)
Укладка:  COUNT(*) = 1
Массаж:   COUNT(*) = 1
```

### Правильный подсчет (нужно):
```
Стрижка:  COUNT(DISTINCT r.id) = 3  ✅ (все 3 записи)
Укладка:  COUNT(DISTINCT r.id) = 1
Массаж:   COUNT(DISTINCT r.id) = 1
```

---

## Где исправлять

**Файл:** `backend/routes/api.js`  
**Строка:** 112  
**Функция:** `router.get('/analytics/dashboard', ...)`

**Заменить:**
```javascript
// Старое:
db.many(`SELECT svc->>'title' as service_name, COUNT(*) as cnt, ...`)

// На:
db.many(`SELECT svc->>'title' as service_name, COUNT(DISTINCT r.id) as cnt, ...`)
```

---

## Проверка после исправления

1. На дашборде "Топ услуг" должны показывать **реальное количество записей**, а не услуг
2. Услуга, встречающаяся в одной записи с 5 услугами, должна считаться как 1, а не как 5
3. Сравнить с YClients аналитикой (если есть) → должны совпадать

---

## Дополнительно

### Фронтенд (проверить в порядке)
**Файл:** `frontend/js/pages/dashboard.js:53-64`

Функция `buildTopSvc()` просто отображает данные из API. После исправления бэка будет показывать корректные значения автоматически.

---

## Резюме

- **Что исправлять:** SQL запрос в backend/routes/api.js:112
- **Изменение:** `COUNT(*)` → `COUNT(DISTINCT r.id)`
- **Результат:** Дашборд покажет правильное количество записей для каждой услуги
- **Тестирование:** Проверить в браузере — "Топ услуг" должны совпадать с YClients
