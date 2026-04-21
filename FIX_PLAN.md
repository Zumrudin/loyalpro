# 🔧 ПЛАН ИСПРАВЛЕНИЯ БАГИ YCLIENTS

## Обнаруженные проблемы

### 🔴 КРИТИЧНЫЕ (блокируют синхронизацию)

**Баг 1:** Frontend не отправляет Company ID
- Функция `connectYC()` в `/frontend/index.html` не включает `yclients_company_id` в request body
- Хотя значение есть в input `#st-yid`, оно не отправляется на сервер

**Баг 2:** Backend не сохраняет Company ID  
- Endpoint `/api/salon/yclients-auth` в `server.js` не принимает `yclients_company_id`
- SQL UPDATE не обновляет это поле

**Результат:** Company ID остаётся NULL, синхронизация падает

---

## Решение

### Шаг 1: Исправить Frontend (5 минут)
**Файл:** `/root/loyalpro/frontend/index.html`
**Функция:** `connectYC()` (строка ~1228)

**Изменение:**
```javascript
// ДО:
await api('POST','/api/salon/yclients-auth',{
  partnerToken: pt,
  login: login,
  password: pass,
  chainId: document.getElementById('st-chain-id')?.value || null,
});

// ПОСЛЕ:
await api('POST','/api/salon/yclients-auth',{
  partnerToken: pt,
  login: login,
  password: pass,
  yclients_company_id: yid,  // ← ДОБАВИТЬ
  chainId: document.getElementById('st-chain-id')?.value || null,
});
```

### Шаг 2: Исправить Backend (5 минут)
**Файл:** `/root/loyalpro/server.js`
**Endpoint:** `POST /api/salon/yclients-auth` (строка ~588)

**Изменение 1** (деструктуризация):
```javascript
// ДО:
const { partnerToken, login, password } = req.body;

// ПОСЛЕ:
const { partnerToken, login, password, yclients_company_id } = req.body;
```

**Изменение 2** (SQL UPDATE):
```javascript
// ДО:
'UPDATE salons SET yclients_partner_token=$1,yclients_user_token=$2,updated_at=NOW() WHERE id=$3'
[partnerToken, d.user_token, req.user.salonId]

// ПОСЛЕ:
'UPDATE salons SET yclients_partner_token=$1,yclients_user_token=$2,yclients_company_id=$3,updated_at=NOW() WHERE id=$4'
[partnerToken, d.user_token, yclients_company_id, req.user.salonId]
```

---

## Проверка исправления

1. Пересохранить оба файла
2. **Перезагрузить сервер:**
   ```bash
   # Найти процесс
   ps aux | grep "node server.js"
   # Убить процесс
   kill PID
   # Перезагрузить (если использует PM2)
   pm2 restart server
   # Или запустить заново
   node server.js
   ```

3. **Проверить в приложении:**
   - Открыть Настройки → Интеграция → Подключение YClients
   - Нажать "Подключить YClients" ещё раз
   - Запустить скрипт диагностики:
     ```bash
     node /root/loyalpro/diagnose-sync-bug.js
     ```
   - Проверить что все поля заполнены:
     - Company ID: ✅
     - Partner Token: ✅
     - User Token: ✅

4. **Запустить синхронизацию:**
   - Нажать кнопку "Синхронизировать" в приложении
   - Должна появиться информация о синхронизации

---

## Бонус: Другие найденные проблемы

### ⚠️ Недостающий endpoint `/api/yclients/card-types`
- Frontend вызывает этот endpoint для загрузки типов карт лояльности
- Endpoint не существует в server.js
- **Нужно добавить** или использовать существующий

### ⚠️ Параметр chainId отправляется но не используется
- Frontend отправляет `chainId` 
- Backend его игнорирует
- Нужно либо удалить, либо реализовать полностью

---

## Ожидаемый результат

После исправления:
- ✅ Company ID сохраняется в БД
- ✅ Синхронизация проверяет все требуемые поля
- ✅ Кнопка "Синхронизировать" работает
- ✅ Данные загружаются с Yclients

---

## Время на исправление: **10 минут**

Оба исправления просты, локальны и не требуют изменения схемы БД.
