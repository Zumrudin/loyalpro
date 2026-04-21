# 🚀 Как запустить тест API сообщений YClients

## Подготовка

### 1. Найти ваши YClients токены

Вам нужны 3 значения:
- **Partner Token** — получить в личном кабинете YClients (Настройки → Интеграции → API)
- **User Token** — получить после авторизации через API
- **Company ID** — ID вашей компании в YClients (видно в профиле)

### 2. Способ 1: Через переменные окружения (рекомендуется)

Создайте файл `.env` в папке `backend/`:

```bash
YCLIENTS_PARTNER_TOKEN=your_partner_token_here
YCLIENTS_USER_TOKEN=your_user_token_here
YCLIENTS_COMPANY_ID=your_company_id_here
```

Или установите переменные в консоли:

```bash
export YCLIENTS_PARTNER_TOKEN="your_partner_token"
export YCLIENTS_USER_TOKEN="your_user_token"
export YCLIENTS_COMPANY_ID="your_company_id"
```

### 3. Способ 2: Отредактировать скрипт напрямую

Отредактируйте `yclients-messages-explore.js` строки 18-21:

```javascript
const CONFIG = {
  partner_token: 'YOUR_PARTNER_TOKEN_HERE',
  user_token: 'YOUR_USER_TOKEN_HERE',
  company_id: 'YOUR_COMPANY_ID_HERE',
};
```

## Запуск теста

```bash
cd backend
node yclients-messages-explore.js
```

## Что смотреть в выводе

### ✅ Успешный результат

```
📡 GET /company/12345/messages
✅ Success! Data type: Array
   Items: 5
   Sample keys: id, client_id, text, messenger_type, created_at, ...
   Full sample: { id: 1, client_id: 123, text: "Привет!", ... }
```

Это означает:
- ✅ API для сообщений **работает**
- ✅ Сообщения доступны через REST API
- ✅ Можем использовать прямую синхронизацию

### ❌ Неудачный результат

```
❌ API Error: Method not found
```

Это означает:
- ❌ API для сообщений **НЕ доступен** через этот endpoint
- ✅ Нужно проверить другие endpoints
- ⚠️ Может быть нужен webhook или прямая интеграция с мессенджерами

## Ключевые моменты для анализа

### 1. Структура данных сообщения

Ищите поля:
- `id` или `external_id` — уникальный ID сообщения
- `client_id` — ID клиента в YClients
- `text` или `message` — текст сообщения
- `messenger_type` — тип мессенджера (telegram, whatsapp, max)
- `sender_id` или `from_id` — кто отправил (клиент или стаф)
- `created_at` или `date` — когда отправлено
- `direction` или `type` — входящее/исходящее

### 2. Работающие endpoints

Обратите внимание, какие endpoints вернули данные:
- `/company/{id}/messages` — сообщения компании
- `/client/{company_id}/{client_id}/messages` — сообщения клиента
- `/messengers` — список подключенных мессенджеров
- Другие...

### 3. Информация о клиентах

В деталях клиента ищите:
- `telegram_id` — контакт Telegram
- `whatsapp` или `phone` — для WhatsApp
- `max_id` или другие ID мессенджеров
- `messengers` — список всех контактов

### 4. Информация в записях

Проверьте, содержат ли записи:
- Поле `notes` или `description` с текстом
- Связанные сообщения
- Другие контактные данные

## Пример интерпретации результатов

### Сценарий 1: API сообщений есть ✅

```
📡 GET /company/12345/messages
✅ Success! Data type: Array
   Items: 25

📡 GET /client/12345/789/messages
✅ Success! Data type: Array
   Items: 5
```

**Вывод:** Можем использовать REST API для синхронизации.

**Следующий шаг:** 
```javascript
async function syncMessagesFromAPI() {
  const messages = await ycGet(
    `/company/${companyId}/messages`,
    { page: 1, count: 100 }
  );
  // Сохранить в БД
}
```

---

### Сценарий 2: API сообщений нет ❌

```
❌ API Error: Endpoint not found (для всех endpoints)
```

**Вывод:** API сообщений не доступен в REST.

**Следующие шаги:**
1. Проверить наличие информации о мессенджерах в деталях клиента
2. Рассмотреть webhook интеграцию
3. Интегрировать напрямую с Telegram Bot API и т.д.

---

## Если получилась ошибка аутентификации

```
❌ Request Error: 401 Unauthorized
   → Проблема с аутентификацией. Проверьте токены.
```

**Решение:**
1. Проверьте, что токены скопированы правильно (без лишних пробелов)
2. Убедитесь, что Partner Token и User Token на месте
3. Проверьте Company ID
4. Токены могут быть скопированы из:
   - YClients Личный кабинет → Настройки → API
   - Письмо от YClients с доступами

## Что делать после теста

1. **Скопировать вывод скрипта** в файл для анализа
2. **Определить доступные endpoints**
3. **Проанализировать структуру данных**
4. **Спроектировать модуль** (БД, синхронизация, UI)
5. **Реализовать модуль**

## Полезные ссылки

- **YClients API Docs:** https://developers.yclients.com/ru/
- **Поиск в документации:** ищите "сообщения", "messages", "chat", "messengers"
- **Примеры интеграции в проекте:** смотрите `server.js` как реализована синхронизация записей и клиентов

---

## Быстрая диагностика

```bash
# Просто запустить:
cd backend && node yclients-messages-explore.js 2>&1 | tee message-test-output.txt

# Потом посмотреть результаты:
cat message-test-output.txt
```

Успехов в исследовании! 🚀
