-- Базовая схема LoyalPro для ПУСТОЙ базы (восстановлена 03.11.2026).
--
-- ЗАЧЕМ: migrations.js только дописывает колонки и новые таблицы поверх
-- существующих salons/clients/users/records/... — их CREATE в репозитории не было
-- никогда (схема создавалась руками в 2025). После атаки на Beget 02.11.2026 живой
-- базы не осталось, и поднять бэкенд с нуля без этого файла нельзя.
--
-- ИСТОЧНИК: колонки и типы — из выводов information_schema в журналах прошлых
-- сессий (salons, clients, users, records, finances_log, loyalty_card_transactions,
-- sync_logs, goods_sales, goods_sale_items); bonus_transactions, loyalty_settings,
-- webhook_logs — по запросам в коде. Уникальные ключи — по ON CONFLICT в коде.
-- Только IF NOT EXISTS: на существующей базе файл ничего не меняет.
--
-- Порядок: этот файл → старт бэкенда (runMigrations дописывает остальное).

CREATE TABLE IF NOT EXISTS salons (
  id                       SERIAL PRIMARY KEY,
  name                     VARCHAR(255) NOT NULL,
  city                     VARCHAR(255),
  timezone                 VARCHAR(64) DEFAULT 'Europe/Moscow',
  yclients_company_id      VARCHAR(64),
  yclients_partner_token   TEXT,
  yclients_user_token      TEXT,
  webhook_secret           VARCHAR(128),
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  yclients_card_type_id    INTEGER,
  yclients_card_type_name  VARCHAR(255),
  yclients_login           VARCHAR(255),
  yclients_password        VARCHAR(255),
  yclients_chain_id        VARCHAR(64),
  yclients_web_cookie      TEXT,
  template_logo_url        TEXT,
  template_wm_url          TEXT,
  template_accent_color    VARCHAR(32),
  template_bg_color        VARCHAR(32),
  template_text_color      VARCHAR(32),
  template_logo_line1      VARCHAR(255),
  template_logo_line2      VARCHAR(255),
  template_subtitle        VARCHAR(255),
  template_contact_phone   VARCHAR(255),
  template_contact_web     VARCHAR(255),
  template_contact_social  VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS users (
  id                SERIAL PRIMARY KEY,
  salon_id          INTEGER REFERENCES salons(id) ON DELETE CASCADE,
  email             VARCHAR(255) NOT NULL UNIQUE,
  password_hash     VARCHAR(255) NOT NULL,
  name              VARCHAR(255),
  role              VARCHAR(32) NOT NULL DEFAULT 'admin',
  last_login_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Уровни по умолчанию — заглушка: реальные уровни PERI были только в потерянной
-- базе, владелец задаёт их в «Настройках». bonuses_enabled в строке салона
-- выключается при посеве (см. runbook): журнал начислений потерян.
CREATE TABLE IF NOT EXISTS loyalty_settings (
  salon_id                 INTEGER PRIMARY KEY REFERENCES salons(id) ON DELETE CASCADE,
  levels                   JSONB NOT NULL DEFAULT '[{"key":"base","name":"Базовый","minSpent":0,"cashback":5}]',
  service_cashback         JSONB NOT NULL DEFAULT '{}',
  birthday_bonus           INTEGER DEFAULT 0,
  birthday_days_before     INTEGER DEFAULT 3,
  birthday_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  referral_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  referral_bonus_sender    INTEGER DEFAULT 0,
  referral_bonus_receiver  INTEGER DEFAULT 0,
  bonus_expiry_days        INTEGER DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clients (
  id                     SERIAL PRIMARY KEY,
  salon_id               INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  yclients_client_id     BIGINT,
  name                   VARCHAR(255),
  phone                  VARCHAR(32),
  email                  VARCHAR(255),
  birthday               DATE,
  telegram_id            VARCHAR(64),
  vk_id                  VARCHAR(64),
  bonus_balance          INTEGER NOT NULL DEFAULT 0,
  total_spent            NUMERIC NOT NULL DEFAULT 0,
  loyalty_level          VARCHAR(64),
  visits_count           INTEGER NOT NULL DEFAULT 0,
  referral_code          VARCHAR(64),
  referred_by_id         INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  yclients_data          JSONB,
  last_visit_at          TIMESTAMPTZ,
  synced_at              TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  yclients_card_id       BIGINT,
  yclients_card_number   VARCHAR(64),
  yclients_card_balance  NUMERIC,
  gender                 VARCHAR(16),
  UNIQUE (salon_id, yclients_client_id)
);
CREATE INDEX IF NOT EXISTS idx_clients_salon_phone ON clients (salon_id, phone);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients (phone);

CREATE TABLE IF NOT EXISTS records (
  id                  SERIAL PRIMARY KEY,
  salon_id            INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  yclients_record_id  BIGINT NOT NULL,
  client_id           INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  yclients_client_id  BIGINT,
  visit_date          DATE,
  visit_datetime      TIMESTAMPTZ,
  amount              NUMERIC NOT NULL DEFAULT 0,
  services            JSONB,
  staff               JSONB,
  status              VARCHAR(32),
  bonus_accrued       INTEGER NOT NULL DEFAULT 0,
  cashback_pct        NUMERIC,
  bonus_processed     BOOLEAN NOT NULL DEFAULT FALSE,
  source              VARCHAR(32),
  raw_payload         JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  service_name        TEXT,
  specialist_name     TEXT,
  UNIQUE (salon_id, yclients_record_id)
);
CREATE INDEX IF NOT EXISTS idx_records_client ON records (client_id);
CREATE INDEX IF NOT EXISTS idx_records_salon_date ON records (salon_id, visit_date);
CREATE INDEX IF NOT EXISTS idx_records_yc_client ON records (salon_id, yclients_client_id);

CREATE TABLE IF NOT EXISTS finances_log (
  id                  SERIAL PRIMARY KEY,
  salon_id            INTEGER REFERENCES salons(id) ON DELETE CASCADE,
  yclients_record_id  BIGINT,
  client_id           INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  event_status        VARCHAR(64),
  paid_amount         NUMERIC,
  cashback_pct        NUMERIC,
  card_id             BIGINT,
  processed           BOOLEAN NOT NULL DEFAULT FALSE,
  raw_payload         JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_card_transactions (
  id                SERIAL PRIMARY KEY,
  salon_id          INTEGER REFERENCES salons(id) ON DELETE CASCADE,
  client_id         INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  yclients_card_id  BIGINT,
  yclients_txn_id   BIGINT,
  type              VARCHAR(32),
  amount            NUMERIC NOT NULL DEFAULT 0,
  balance_after     NUMERIC,
  title             TEXT,
  record_id         BIGINT,
  txn_date          TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lct_client ON loyalty_card_transactions (client_id);
CREATE INDEX IF NOT EXISTS idx_lct_salon_date ON loyalty_card_transactions (salon_id, txn_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lct_yc_txn ON loyalty_card_transactions (yclients_txn_id) WHERE yclients_txn_id IS NOT NULL;

-- Ручные/импортированные бонусы старой схемы; код только читает.
CREATE TABLE IF NOT EXISTS bonus_transactions (
  id             SERIAL PRIMARY KEY,
  salon_id       INTEGER REFERENCES salons(id) ON DELETE CASCADE,
  client_id      INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  type           VARCHAR(32),
  amount         NUMERIC NOT NULL DEFAULT 0,
  balance_after  NUMERIC,
  description    TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sync_logs (
  id               SERIAL PRIMARY KEY,
  salon_id         INTEGER REFERENCES salons(id) ON DELETE CASCADE,
  sync_type        VARCHAR(32),
  status           VARCHAR(32),
  clients_synced   INTEGER DEFAULT 0,
  records_synced   INTEGER DEFAULT 0,
  bonuses_accrued  INTEGER DEFAULT 0,
  new_clients      INTEGER DEFAULT 0,
  error_message    TEXT,
  initiated_by     INTEGER,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS webhook_logs (
  id             SERIAL PRIMARY KEY,
  salon_id       INTEGER REFERENCES salons(id) ON DELETE CASCADE,
  event_type     VARCHAR(64),
  resource_id    VARCHAR(64),
  payload        JSONB,
  processed      BOOLEAN NOT NULL DEFAULT FALSE,
  processing_ms  INTEGER,
  error_message  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_salon_created ON webhook_logs (salon_id, created_at DESC);

CREATE TABLE IF NOT EXISTS goods_sales (
  id                  SERIAL PRIMARY KEY,
  salon_id            INTEGER REFERENCES salons(id) ON DELETE CASCADE,
  yclients_record_id  BIGINT,
  source              VARCHAR(32),
  yclients_client_id  BIGINT,
  client_id           INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  sale_date           DATE,
  total_amount        NUMERIC,
  synced_at           TIMESTAMP DEFAULT NOW(),
  UNIQUE (salon_id, yclients_record_id)
);

CREATE TABLE IF NOT EXISTS goods_sale_items (
  id                          SERIAL PRIMARY KEY,
  sale_id                     INTEGER REFERENCES goods_sales(id) ON DELETE CASCADE,
  yclients_transaction_id     BIGINT UNIQUE,
  yclients_goods_id           INTEGER,
  title                       TEXT,
  article                     VARCHAR(255),
  quantity                    NUMERIC,
  price_per_unit              NUMERIC,
  total_price                 NUMERIC,
  discount                    NUMERIC,
  assigned_staff_yclients_id  INTEGER,
  storage_id                  INTEGER
);
