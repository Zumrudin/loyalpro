# 📋 План разработки модуля сообщений LoyalPro

## 🎯 Общая цель

Создать модуль для работы с переписками клиентов из YClients, интегрировав сообщения из всех подключенных мессенджеров (Telegram, WhatsApp, MAX и т.д.) в единый интерфейс.

## 📌 Текущий статус: Этап исследования

### ✅ Что уже сделано

1. **yclients-messages-explore.js** — тестовый скрипт для исследования YClients API
2. **MESSAGES_API_RESEARCH.md** — анализ подходов и возможностей
3. **RUN_MESSAGE_TEST.md** — инструкция по запуску тестов
4. **MESSAGES_DB_SCHEMA.sql** — предложенная схема БД
5. **MESSAGES_MODULE_PLAN.md** — этот файл (план разработки)

### ⏭️ Следующий шаг: Исследование API

```bash
cd backend
node yclients-messages-explore.js
```

## 🔍 Фаза 1: Исследование и анализ (ТЕКУЩАЯ)

### Задачи

- [ ] Запустить `yclients-messages-explore.js`
- [ ] Проанализировать результаты
- [ ] Определить, какие endpoints доступны для сообщений
- [ ] Понять структуру данных
- [ ] Документировать выводы

### Ожидаемые результаты

**Результат А: API сообщений доступен ✅**
```
✅ GET /company/{id}/messages работает
✅ Структура: { id, client_id, text, messenger_type, created_at, ... }
✅ Можно получать сообщения через REST API
```

→ Переходим к Фазе 2А (REST API интеграция)

---

**Результат B: API сообщений недоступен ❌**
```
❌ Все endpoints для сообщений возвращают 404/error
✅ Но информация о мессенджерах есть в деталях клиента
```

→ Переходим к Фазе 2B (Webhook или прямая интеграция)

---

**Результат C: Информация в других местах**
```
✅ Сообщения/контакты есть в записях или в деталях клиента
✅ Нужно парсить/обработать имеющиеся данные
```

→ Переходим к Фазе 2C (Доработка существующих данных)

---

## 🛠️ Фаза 2A: REST API интеграция (если API доступен)

### Задачи

- [ ] Создать миграцию БД (MESSAGES_DB_SCHEMA.sql)
- [ ] Добавить функцию `syncClientMessages()` в server.js
- [ ] Добавить функцию `ycGetMessages()` для получения сообщений из API
- [ ] Реализовать логику избежания дубликатов (через external_message_id)
- [ ] Добавить endpoint: `GET /api/salon/messages?client_id=X`
- [ ] Обновить UI для отображения сообщений в чате
- [ ] Добавить синхронизацию в основной цикл `syncSalon()`

### Пример кода

```javascript
// Получить сообщения из API YClients
async function ycGetMessages(salon, clientId, page = 1) {
  return await ycGet(salon, `/client/${salon.yclients_company_id}/${clientId}/messages`, {
    page,
    count: 100,
  });
}

// Синхронизировать сообщения клиента
async function syncClientMessages(salon, clientId) {
  try {
    let page = 1;
    const processed = new Set();

    for (;;) {
      const msgs = await ycGetMessages(salon, clientId, page);
      if (!msgs?.length) break;

      for (const msg of msgs) {
        // Избежать дубликатов
        if (processed.has(msg.id)) continue;
        processed.add(msg.id);

        // Сохранить в БД
        await db.query(
          `INSERT INTO messages
             (salon_id, client_id, message_text, external_message_id,
              messenger_type, sender_type, message_date, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (salon_id, client_id, external_message_id) DO NOTHING`,
          [
            salon.id,
            clientId,
            msg.text || msg.message,
            msg.id,
            msg.messenger_type,
            msg.direction === 'incoming' ? 'client' : 'staff',
            msg.created_at || msg.date,
          ]
        );
      }

      if (msgs.length < 100) break;
      page++;
    }
  } catch (e) {
    console.error(`[Messages] Error syncing client ${clientId}:`, e.message);
  }
}

// API endpoint
app.get('/api/salon/messages', requireAuth, async (req, res) => {
  const { client_id, limit = 50 } = req.query;
  const salonId = req.user.salon_id;

  const messages = await db.query(
    `SELECT id, client_id, message_text, messenger_type, sender_type,
            message_date, is_read
     FROM messages
     WHERE salon_id = $1 AND client_id = $2
     ORDER BY message_date DESC
     LIMIT $3`,
    [salonId, client_id, limit]
  );

  res.json(messages.rows);
});
```

---

## 🔧 Фаза 2B: Webhook интеграция (если API недоступен)

### Задачи

- [ ] Проверить наличие Webhook в YClients
- [ ] Настроить Webhook для получения событий сообщений
- [ ] Создать endpoint: `POST /webhooks/yclients/message`
- [ ] Обработать входящие события и сохранить в БД
- [ ] Убедиться в безопасности (проверка подписи от YClients)

### Пример кода

```javascript
// Webhook для получения сообщений от YClients
app.post('/webhooks/yclients/message', async (req, res) => {
  try {
    const { client_id, message, messenger_type, timestamp, salon_id } = req.body;

    // Проверка подписи (если YClients это поддерживает)
    // const isValid = verifyYClientsWebhookSignature(req);
    // if (!isValid) return res.status(401).json({ error: 'Invalid signature' });

    // Сохранить сообщение
    await db.query(
      `INSERT INTO messages
         (salon_id, client_id, message_text, external_message_id,
          messenger_type, sender_type, message_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (salon_id, client_id, external_message_id) DO NOTHING`,
      [
        salon_id,
        client_id,
        message.text,
        message.id,
        messenger_type,
        'client', // из webhook обычно только входящие
        new Date(timestamp),
      ]
    );

    // Отправить update в UI через WebSocket (если нужно real-time)
    broadcastMessageUpdate(salon_id, client_id);

    res.json({ ok: true });
  } catch (e) {
    console.error('[Webhook] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

---

## 💬 Фаза 2C: Прямая интеграция с мессенджерами

### Если YClients API недоступен, но нужны сообщения

### Telegram Bot API

```javascript
// Получить обновления из Telegram
async function syncTelegramMessages(salon, clientId) {
  const telegramId = await getClientTelegramId(salon, clientId);
  if (!telegramId) return;

  // Использовать Telegram Bot API для получения сообщений
  // (требует спец. конфигурации)
}
```

### WhatsApp Business API

Требует отдельной интеграции и платной подписки на WhatsApp Business.

---

## 📊 Фаза 3: Реализация и интеграция

### Задачи

- [ ] Выбрать подход на основе результатов Фазы 1
- [ ] Создать миграцию БД
- [ ] Реализовать синхронизацию сообщений
- [ ] Создать API endpoints
- [ ] Обновить фронтенд

### Структура файлов

```
backend/
├── server.js (добавить ycGetMessages, syncClientMessages, API endpoint)
├── messages-sync.js (опционально, отдельный модуль для синхронизации)
└── migrations/
    └── 001-messages-tables.sql

frontend/
├── index.html (обновить UI вкладку "Чат")
└── js/
    └── messages.js (новый модуль для работы с сообщениями)
```

---

## 🎨 Фаза 4: UI интеграция

### На главном экране

- [ ] Обновить вкладку "Чат" для отображения сообщений из БД
- [ ] Добавить фильтрацию по мессенджерам (Telegram, WhatsApp, MAX)
- [ ] Добавить поиск по тексту сообщений
- [ ] Показать непрочитанные сообщения
- [ ] Обновления в real-time (если используется WebSocket)

### На странице клиента

- [ ] Показать историю сообщений клиента
- [ ] Отправка ответа (если нужно)
- [ ] Статус прочитанности

---

## 📈 Фаза 5: Расширения и оптимизации

### После базовой реализации

- [ ] Анализ сообщений (AI классификация, сентимент)
- [ ] Автоответы на типовые вопросы
- [ ] Интеграция с CRM (связь сообщений с записями в Ялаклиентс)
- [ ] Экспорт переписок
- [ ] Интеграция с помощью сообщениям от сотрудников
- [ ] Уведомления о новых сообщениях

---

## 🚀 Порядок работы (СЕЙЧАС)

### ШАГ 1: Запустить исследование

```bash
cd backend
node yclients-messages-explore.js
```

Сохраните вывод (можно в файл):
```bash
node yclients-messages-explore.js > message-test-output.txt 2>&1
```

### ШАГ 2: Проанализировать результаты

Ищите в выводе:
- ✅ Какие endpoints вернули данные?
- ✅ Какая структура данных?
- ✅ Есть ли информация о мессенджерах в клиентах?

### ШАГ 3: Задокументировать выводы

Создать файл `MESSAGES_RESEARCH_RESULTS.md` с выводами:
```markdown
# Результаты исследования

## Доступные endpoints
- ✅ /company/{id}/messages — работает
- ❌ /client/{id}/{cid}/messengers — не работает
- ...

## Структура данных сообщения
- id, client_id, text, messenger_type, ...

## Рекомендованный подход
→ REST API интеграция (Фаза 2A)

## Следующие шаги
1. Создать таблицы в БД
2. Реализовать syncClientMessages()
3. Добавить API endpoint
4. Обновить UI
```

### ШАГ 4: Выбрать и запустить соответствующую фазу

На основе результатов исследования:
- **Фаза 2A** — если API работает
- **Фаза 2B** — если нужен Webhook
- **Фаза 2C** — если нужна прямая интеграция

---

## 📚 Справка по файлам

| Файл | Назначение |
|------|-----------|
| `yclients-messages-explore.js` | Тестовый скрипт для исследования API |
| `MESSAGES_API_RESEARCH.md` | Анализ подходов |
| `RUN_MESSAGE_TEST.md` | Инструкция по запуску |
| `MESSAGES_DB_SCHEMA.sql` | Схема БД |
| `MESSAGES_MODULE_PLAN.md` | Этот файл (план) |

---

## ⚠️ Важные замечания

1. **Не спешить с разработкой** до завершения Фазы 1
2. **Результаты исследования** определят весь подход
3. **Масштабируемость** — с первого дня думать о количестве сообщений
4. **Безопасность** — сообщения могут содержать конфиденциальную информацию
5. **Rate limiting** — YClients API может иметь лимиты на запросы

---

## 🎬 Начните прямо сейчас!

```bash
# 1. Перейти в папку проекта
cd /root/loyalpro/backend

# 2. Отредактировать CONFIG в yclients-messages-explore.js
# (или установить переменные окружения)

# 3. Запустить тест
node yclients-messages-explore.js

# 4. Проанализировать результаты
# 5. Задокументировать выводы
# 6. Перейти к соответствующей фазе разработки
```

Успехов! 🚀
