-- ============================================================================
-- Schema для модуля работы с сообщениями клиентов в LoyalPro
--
-- Таблицы для хранения переписок из различных мессенджеров
-- (Telegram, WhatsApp, MAX и др.)
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Таблица сообщений
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  salon_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,

  -- Информация о сообщении
  message_text TEXT,
  external_message_id VARCHAR(500), -- ID сообщения в YClients/мессенджере

  -- Мессенджер и направление
  messenger_type VARCHAR(50) NOT NULL, -- 'telegram', 'whatsapp', 'max', 'viber', etc.
  sender_type VARCHAR(20) NOT NULL, -- 'client' или 'staff' (кто отправил)
  sender_name VARCHAR(255), -- Имя отправителя (для staff)

  -- Служебные поля
  is_read BOOLEAN DEFAULT FALSE,
  message_date TIMESTAMP, -- Когда было отправлено сообщение
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  synced_at TIMESTAMP, -- Когда в последний раз синхронизировано с API

  -- Ограничения
  FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT external_msg_unique UNIQUE(salon_id, client_id, external_message_id)
);

-- Индексы для быстрого поиска
CREATE INDEX idx_messages_salon_client
  ON messages(salon_id, client_id, message_date DESC);
CREATE INDEX idx_messages_client_unread
  ON messages(client_id, is_read) WHERE is_read = FALSE;
CREATE INDEX idx_messages_external_id
  ON messages(external_message_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Таблица синхронизации (для отслеживания последнего синхронизирования)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messages_sync_log (
  id SERIAL PRIMARY KEY,
  salon_id INTEGER NOT NULL,

  -- Информация о синхронизации
  messenger_type VARCHAR(50), -- NULL = все мессенджеры
  sync_type VARCHAR(50) NOT NULL, -- 'full' или 'incremental'

  -- Статус
  status VARCHAR(50) NOT NULL, -- 'started', 'completed', 'failed'
  error_message TEXT,

  -- Статистика
  messages_fetched INTEGER DEFAULT 0,
  messages_saved INTEGER DEFAULT 0,
  messages_skipped INTEGER DEFAULT 0,

  -- Временные метки
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,

  FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_sync_salon
  ON messages_sync_log(salon_id, completed_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Таблица для отслеживания подключенных мессенджеров (опционально)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS salon_messengers (
  id SERIAL PRIMARY KEY,
  salon_id INTEGER NOT NULL UNIQUE,

  -- Статус подключения каждого мессенджера
  telegram_enabled BOOLEAN DEFAULT FALSE,
  whatsapp_enabled BOOLEAN DEFAULT FALSE,
  max_enabled BOOLEAN DEFAULT FALSE,
  viber_enabled BOOLEAN DEFAULT FALSE,

  -- Дополнительные метаданные
  last_sync_at TIMESTAMP,
  sync_interval_minutes INTEGER DEFAULT 15, -- как часто синхронизировать

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE
);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Таблица для хранения привязки мессенджеров к клиентам (опционально)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS client_messenger_contacts (
  id SERIAL PRIMARY KEY,
  salon_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,

  -- Контактная информация в разных мессенджерах
  telegram_id VARCHAR(255),
  whatsapp_phone VARCHAR(255),
  max_id VARCHAR(255),
  viber_id VARCHAR(255),

  -- Служебные поля
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT client_messengers_unique UNIQUE(salon_id, client_id)
);

CREATE INDEX idx_client_messengers_salon
  ON client_messenger_contacts(salon_id, client_id);

-- ════════════════════════════════════════════════════════════════════════════
-- ПРИМЕРЫ ЗАПРОСОВ
-- ════════════════════════════════════════════════════════════════════════════

/*

-- Получить все сообщения клиента (с сортировкой по времени)
SELECT
  id, client_id, message_text, messenger_type, sender_type,
  message_date, is_read
FROM messages
WHERE salon_id = $1 AND client_id = $2
ORDER BY message_date DESC
LIMIT 50;

-- Получить непрочитанные сообщения для конкретного клиента
SELECT COUNT(*) as unread_count
FROM messages
WHERE salon_id = $1 AND client_id = $2 AND is_read = FALSE;

-- Получить статистику по мессенджерам
SELECT
  messenger_type,
  COUNT(*) as total_messages,
  COUNT(DISTINCT client_id) as clients_with_messages
FROM messages
WHERE salon_id = $1
  AND message_date >= NOW() - INTERVAL '7 days'
GROUP BY messenger_type;

-- Найти клиентов с активной распиской последних N дней
SELECT DISTINCT client_id
FROM messages
WHERE salon_id = $1
  AND message_date >= NOW() - INTERVAL '7 days'
  AND sender_type = 'client'
ORDER BY client_id;

-- Проверить статус синхронизации
SELECT
  messenger_type,
  MAX(completed_at) as last_sync,
  status,
  error_message
FROM messages_sync_log
WHERE salon_id = $1
GROUP BY messenger_type, status, error_message;

*/

-- ════════════════════════════════════════════════════════════════════════════
-- ПРИМЕЧАНИЯ
-- ════════════════════════════════════════════════════════════════════════════

/*

1. ТАБЛИЦА messages
   - Основная таблица для хранения всех сообщений
   - external_message_id нужен для избежания дубликатов при синхронизации
   - message_text может быть очень большим (TEXT), не ограничивайте
   - Индекс idx_messages_salon_client критичен для быстрого отображения чата

2. ТАБЛИЦА messages_sync_log
   - Для отслеживания процесса синхронизации
   - Помогает отладке и восстановлению после сбоев
   - Ведет статистику (сколько было получено/сохранено)

3. ОПЦИОНАЛЬНЫЕ ТАБЛИЦЫ
   - salon_messengers: если нужны настройки синхронизации per-salon
   - client_messenger_contacts: если нужно хранить контакты в мессенджерах

   Можно начать без них, добавить позже если понадобятся.

4. ВРЕМЕННЫЕ МЕТКИ
   - message_date: когда было отправлено сообщение (от YClients API)
   - created_at: когда мы его получили и сохранили
   - synced_at: для версионирования (если переправлять)
   - updated_at: для отслеживания изменений

5. ИНДЕКСЫ
   - Важно создать правильные индексы для быстрого поиска
   - idx_messages_salon_client используется при отображении чата
   - idx_messages_client_unread используется для счетчика непрочитанных

6. МАСШТАБИРУЕМОСТЬ
   - Если сообщений будет много (миллионы), рассмотреть:
     - Партиционирование по salon_id или дате
     - Архивирование старых сообщений
     - Отдельную БД для сообщений

7. БЕЗОПАСНОСТЬ
   - message_text может содержать личную информацию
   - Не логируйте полный текст сообщений в логах
   - Учитывайте GDPR при удалении данных клиентов

*/
