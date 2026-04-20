# Дизайн: поле «Должность» для пользователей

**Дата:** 2026-04-20

## Цель

Добавить атрибут «Должность» (свободный текст) к пользователям системы. В модуле домашнего ухода отображать должность специалиста вместо системной роли (owner/admin/specialist).

## База данных

```sql
ALTER TABLE users ADD COLUMN position VARCHAR(100);
```

Поле необязательное (NULL по умолчанию).

## Backend

### `/api/users` — [backend/routes/users.js](backend/routes/users.js)

- `GET /` — добавить `u.position` в SELECT
- `POST /` — принимать `position` из тела запроса, сохранять в INSERT
- `PATCH /:id` — принимать `position`, добавить в динамический UPDATE

### Домашний уход — [backend/routes/home-care.js](backend/routes/home-care.js)

Во всех трёх запросах (GET список, GET/:id, GET/:id/pdf) добавить к JOIN:
```sql
u.position as specialist_position
```

### Мобильный клиент — [backend/routes/mobile-client.js](backend/routes/mobile-client.js)

В обоих запросах (`GET /prescriptions`, `GET /prescriptions/:id`) добавить:
```sql
u.position as "specialistPosition"
```
Убрать или дополнить `u.role as "specialistRole"` — показывать должность вместо роли.

## Frontend

### Управление пользователями — [frontend/js/pages/users.js](frontend/js/pages/users.js)

- Таблица: добавить колонку «Должность» между именем и ролью
- Форма создания/редактирования: поле `<input>` «Должность» (необязательное), передавать в POST/PATCH

### Домашний уход — [frontend/js/pages/home-care.js](frontend/js/pages/home-care.js)

- Таблица назначений: показывать `specialist_position` под именем специалиста (мелким текстом) или в той же ячейке
- PDF/превью: отображать должность рядом с именем специалиста в карточке

## Ограничения

- Должность не влияет на права доступа — системная роль (`role`) остаётся неизменной
- Если должность не заполнена — поле просто не отображается
