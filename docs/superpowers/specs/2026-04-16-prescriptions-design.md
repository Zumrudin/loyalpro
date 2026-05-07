# Дизайн: Назначения (Домашний уход) в мобильном приложении

**Дата:** 2026-04-16  
**Статус:** Утверждён

## Обзор

Добавляем в мобильное приложение отображение назначений врача (домашний уход, лист назначений, витамины) из LoyalPro. Данные берём из существующих таблиц `home_care_prescriptions` и `home_care_items`.

## Структура данных (БД)

### Таблицы
- `home_care_prescriptions` — назначение: `id, salon_id, client_id, specialist_id, notes, created_at, updated_at`
- `home_care_items` — элементы: `prescription_id, time_of_day, category, product_name, instructions, sort_order`
- `users` — специалист: `id, name, role`

### Секции по `time_of_day`
1. **Домашний уход** — `morning`, `evening`, `additional`
2. **Лист назначения** — `sheet_face`, `sheet_body`, `sheet_hair`
3. **Витамины** — `vitamins`

### Миграция
Добавить `record_id INTEGER REFERENCES records(id) ON DELETE SET NULL` в `home_care_prescriptions`. Старые назначения продолжат работать через fallback по дате (same-day match).

## Бэкенд (LoyalPro)

### Миграция в `migrations.js`
```sql
ALTER TABLE home_care_prescriptions ADD COLUMN IF NOT EXISTS record_id INTEGER REFERENCES records(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_hcp_record_id ON home_care_prescriptions(record_id);
```

### Обновление `home-care.js` (POST/PUT)
Принимать опциональный `record_id` в теле запроса и сохранять в БД.

### Новые роуты в `mobile-client.js`

```
GET /mobile/client/prescriptions
  → список назначений клиента (по client_id из токена)
  → сортировка: created_at DESC
  → возвращает: [{ id, created_at, specialist_name, specialist_role, items_count }]

GET /mobile/client/prescriptions/:id
  → полное назначение
  → возвращает: { id, created_at, specialist_name, specialist_role, notes, items[] }
  → items: [{ time_of_day, category, product_name, instructions, sort_order }]
```

### Обновление `GET /mobile/client/bookings`
Добавить флаг `has_prescription` к каждой записи:
- PRIMARY: JOIN по `record_id`
- FALLBACK: совпадение даты (DATE(p.created_at) = DATE(r.date_time)) AND p.client_id = r.client_id

### Обновление `GET /mobile/client/bookings/:bookingId`
Аналогично добавить `prescription_id` (или null) к деталям записи.

## Мобильное приложение

### Новые экраны

**`PrescriptionsScreen`**
- Список карточек, новые сверху
- Карточка: дата, ФИО + должность специалиста, краткий счётчик ("5 назначений")
- Pull-to-refresh
- Пустое состояние если назначений нет

**`PrescriptionDetailScreen`**
- Принимает `prescriptionId` через route.params
- Шапка: дата создания, ФИО и должность врача
- Секции (показываются только если есть items):
  - **Домашний уход**: подсекции Утро / Вечер / Дополнительно — название продукта + инструкция
  - **Лист назначения**: подсекции Лицо / Тело / Волосы — процедура + инструкция
  - **Витамины**: список с иконкой — название + инструкция
- Стиль: "Liquid Glass & Silk" (pearl/champagne/stone, BlurView, LinearGradient)

### Изменения существующих экранов

**`HomeScreen`** — добавить в `cabinetItems`:
```js
{ icon: 'medical-outline', label: 'Назначения', nav: 'Prescriptions', delay: 700 }
```

**`BookingsScreen`** — если `booking.has_prescription === true`:
- Показывать маленький золотой индикатор (точка или бейдж) на карточке записи

**`BookingDetailScreen`** — после секции бонусов:
- Если `bookingDetail.prescription_id` не null — показать карточку "Назначения по визиту"
- Тап → navigate('PrescriptionDetail', { prescriptionId })

### Навигация (`App.js`)
Добавить в RootStack:
```js
<RootStack.Screen name="Prescriptions" component={PrescriptionsScreen} />
<RootStack.Screen name="PrescriptionDetail" component={PrescriptionDetailScreen} />
```

### Стор (`clientStore.js`)
Новые поля и экшны:
```js
prescriptions: [],
prescriptionsLoading: false,
prescriptionDetail: null,
prescriptionDetailLoading: false,
fetchPrescriptions: async () => { ... }
fetchPrescriptionDetail: async (id) => { ... }
```

### API (`client-data.js`)
```js
getPrescriptions: async () => { GET /mobile/client/prescriptions }
getPrescriptionDetail: async (id) => { GET /mobile/client/prescriptions/:id }
```

## Порядок реализации

1. Бэкенд: миграция + новые роуты
2. API клиент: новые методы  
3. Стор: новые поля и экшны
4. PrescriptionsScreen
5. PrescriptionDetailScreen
6. HomeScreen: кнопка Назначения
7. BookingsScreen: индикатор
8. BookingDetailScreen: блок назначений
9. App.js: регистрация экранов
