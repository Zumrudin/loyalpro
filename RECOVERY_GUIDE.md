# 🔄 ИНСТРУКЦИЯ ПО ВОССТАНОВЛЕНИЮ ПРОФИЛЯ YCLIENTS

## Проблема
Токены Yclients не сохраняются в приложении. Синхронизация не работает.

---

## ✅ ВАРИАНТ 1: Через интерфейс приложения (рекомендуемый)

### Шаг 1: Убедитесь, что нажимаете правильную кнопку

На странице **Настройки → Интеграция → Подключение YClients** есть **две кнопки**:

```
[Подключить YClients] [Сохранить]
```

**ВЫ ДОЛЖНЫ НАЖАТЬ: "Подключить YClients"** ← эта кнопка!

(Кнопка "Сохранить" только сохраняет название салона, не токены)

### Шаг 2: Подготовьте данные

Вам понадобятся:

#### A) ID компании
- Войдите на https://yclients.com
- Откройте кабинет
- В URL вы увидите ID: `yclients.com/cabinet/**668791**/...`
- **ID компании = 668791** (или ваш номер)

#### B) Partner Token
- В Yclients: **Настройки → API**
- Скопируйте **Partner Token** (выглядит как `sk_live_...`)

#### C) Email и пароль Yclients
- Это учётные данные вашего профиля в Yclients
- **Email**: например, `zizy05zizy@mail.ru`
- **Пароль**: пароль от профиля Yclients

#### D) Chain ID (опционально)
- Если используете филиалы, это ID салона в Yclients
- Обычно виден в карточке программы лояльности

### Шаг 3: Заполните форму

1. Откройте http://89.125.92.223:3001/
2. Войдите с вашим email
3. Перейдите: **Настройки → Интеграция → Подключение YClients**
4. Заполните поля:
   - **ID компании**: `668791` (ваш ID из URL)
   - **Partner Token**: скопировано из API настроек
   - **Логин YClients**: `zizy05zizy@mail.ru`
   - **Пароль YClients**: ваш пароль
   - **Chain ID**: ID филиала (если есть)

5. **Нажмите: "Подключить YClients"** ⚡

### Шаг 4: Проверка

Если успешно:
- ✅ Появится сообщение: "YClients подключён!"
- ✅ Кнопка "Синхронизировать" станет активной
- ✅ Данные начнут загружаться

Если ошибка:
- ❌ Под кнопкой появится сообщение об ошибке
- Проверьте: правильность пароля, Partner Token, ID компании

---

## 🔧 ВАРИАНТ 2: Прямое восстановление в БД

Если Вариант 1 не работает, используйте скрипт:

### Шаг 1: Подготовьте данные

Собрав все данные:
- **Email**: `zizy05zizy@mail.ru` (ваш логин в loyalpro)
- **Partner Token**: из Yclients API
- **User Token**: уникальный токен вашего профиля (см. ниже)
- **Company ID**: `668791` (ID компании)

### Шаг 2: Как получить User Token?

**Способ 1** (рекомендуемый):
1. Войдите на https://yclients.com с вашим email
2. Откройте DevTools (F12)
3. Перейдите на вкладку **Network** → **XHR**
4. Обновите страницу (Ctrl+R)
5. Найдите любой запрос к API
6. В **Request Headers** найдите: `Authorization: Bearer USER_TOKEN_HERE`
7. Скопируйте это значение

**Способ 2** (через Cookies):
1. F12 → **Application** → **Cookies** → yclients.com
2. Найдите cookie с вашим токеном
3. Или посмотрите в Request Headers любого XHR запроса

### Шаг 3: Запустите скрипт

```bash
cd /root/loyalpro

node restore-yclients.js zizy05zizy@mail.ru "sk_live_YOUR_PARTNER_TOKEN" "YOUR_USER_TOKEN" 668791
```

**Замените на ваши значения:**
- `zizy05zizy@mail.ru` → ваш email
- `sk_live_YOUR_PARTNER_TOKEN` → Partner Token из Yclients
- `YOUR_USER_TOKEN` → User Token (из шага выше)
- `668791` → Company ID (ваш ID)

### Пример:
```bash
node restore-yclients.js zizy05zizy@mail.ru "sk_live_1234567890abcdef" "sU_9876543210fedcba" 668791
```

### Шаг 4: Проверка

После успешного запуска скрипта:
1. Откройте приложение
2. Перейдите: **Настройки → Интеграция**
3. Нажмите **"Синхронизировать"**
4. Данные должны загрузиться ✅

---

## 🐛 Если ничего не помогает

Соберите эту информацию и свяжитесь с техподдержкой:

```
Ошибка: Токены не сохраняются

1. Email профиля: zizy05zizy@mail.ru
2. ID компании в Yclients: ___________
3. Последняя ошибка при подключении: ___________
4. HTTP статус ошибки: ___________

Логи приложения:
- Откройте DevTools (F12)
- Перейдите на вкладку Console
- Скопируйте все красные ошибки
- Отправьте скрины
```

---

## 📌 Быстрая справка

| Данные | Где найти |
|--------|-----------|
| **Partner Token** | yclients.com → Настройки → API |
| **User Token** | DevTools → Network → любой XHR запрос → Authorization header |
| **Company ID** | URL: yclients.com/cabinet/**ID**/... |
| **Chain ID** | Карта лояльности в Yclients → salon_group_id |
| **Email Yclients** | Ваш профиль в Yclients |

---

## ✨ Дополнительные команды

### Проверить сохранённые токены:
```bash
psql $DATABASE_URL -c "SELECT id, name, yclients_company_id, yclients_partner_token, yclients_user_token FROM salons LIMIT 5;"
```

### Очистить старые токены:
```bash
psql $DATABASE_URL -c "UPDATE salons SET yclients_partner_token=NULL, yclients_user_token=NULL WHERE id=YOUR_SALON_ID;"
```

---

**📞 Остались вопросы? Проверьте логи ошибок в DevTools (F12 → Console)**
