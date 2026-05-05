// ============================================================
// Database Migrations
// ============================================================

async function runMigrations(client) {
  // ── Loyalty Settings ───────────────────────────────────────────
  await client.query(`
    ALTER TABLE loyalty_settings
      ADD COLUMN IF NOT EXISTS bonuses_enabled BOOLEAN NOT NULL DEFAULT TRUE
  `).catch(() => {});

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS finances_log_record_id_unique
    ON finances_log (yclients_record_id)
  `).catch(() => {});

  await client.query(`
    ALTER TABLE finances_log
      ADD COLUMN IF NOT EXISTS cashback_amount NUMERIC DEFAULT 0
  `).catch(() => {});

  // ── Staff analytics tables ─────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS staff_members (
      id SERIAL PRIMARY KEY,
      salon_id INTEGER REFERENCES salons(id) ON DELETE CASCADE,
      yclients_staff_id INTEGER NOT NULL,
      name VARCHAR(255),
      specialization VARCHAR(255),
      avatar_url TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      synced_at TIMESTAMP,
      UNIQUE(salon_id, yclients_staff_id)
    )
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS staff_schedule (
      id SERIAL PRIMARY KEY,
      salon_id INTEGER REFERENCES salons(id) ON DELETE CASCADE,
      yclients_staff_id INTEGER NOT NULL,
      date DATE NOT NULL,
      from_time VARCHAR(10),
      to_time VARCHAR(10),
      work_minutes INTEGER DEFAULT 0,
      UNIQUE(salon_id, yclients_staff_id, date)
    )
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS services_config (
      id SERIAL PRIMARY KEY,
      salon_id INTEGER REFERENCES salons(id) ON DELETE CASCADE,
      yclients_service_id INTEGER NOT NULL,
      service_title VARCHAR(255),
      tag VARCHAR(50),
      UNIQUE(salon_id, yclients_service_id)
    )
  `).catch(() => {});

  // ── Staff profile fields ───────────────────────────────────────
  await client.query(`
    ALTER TABLE staff_members
      ADD COLUMN IF NOT EXISTS bio TEXT,
      ADD COLUMN IF NOT EXISTS custom_photo_url TEXT,
      ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT 0
  `).catch(() => {});

  // ── Home Care tables ───────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS home_care_prescriptions (
      id SERIAL PRIMARY KEY,
      salon_id INTEGER REFERENCES salons(id) ON DELETE CASCADE,
      client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      specialist_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      face_procedures TEXT,
      body_procedures TEXT,
      hair_procedures TEXT,
      vitamins TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS home_care_items (
      id SERIAL PRIMARY KEY,
      prescription_id INTEGER REFERENCES home_care_prescriptions(id) ON DELETE CASCADE,
      time_of_day VARCHAR(20) NOT NULL,
      category VARCHAR(100) NOT NULL,
      product_name TEXT NOT NULL,
      instructions TEXT,
      sort_order INTEGER DEFAULT 0
    )
  `).catch(() => {});

  // ── Goods category column ──────────────────────────────────────
  await client.query(`
    ALTER TABLE goods_sale_items ADD COLUMN IF NOT EXISTS yclients_category VARCHAR(200)
  `).catch(() => {});

  // ── Client blacklist flag ──────────────────────────────────────
  await client.query(`
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_blacklisted BOOLEAN NOT NULL DEFAULT FALSE
  `).catch(() => {});

  // ── Client segments table ──────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS client_segments (
      salon_id         INTEGER NOT NULL,
      client_id        INTEGER NOT NULL,
      segment_key      VARCHAR(40) NOT NULL,
      rank             SMALLINT,
      zone             VARCHAR(20),
      days_since_visit INTEGER,
      return_window    INTEGER,
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (salon_id, client_id)
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_client_segments_salon_key
      ON client_segments (salon_id, segment_key)
  `).catch(() => {});

  // ── Role-based access: user management columns ──────────────────
  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE
  `).catch(() => {});

  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE
  `).catch(() => {});

  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id)
  `).catch(() => {});

  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS position VARCHAR(100)
  `).catch(() => {});

  await client.query(`
    ALTER TABLE salons ADD COLUMN IF NOT EXISTS plan VARCHAR(20) NOT NULL DEFAULT 'basic'
  `).catch(() => {});

  await client.query(`
    ALTER TABLE salons ADD COLUMN IF NOT EXISTS max_users INTEGER NOT NULL DEFAULT 5
  `).catch(() => {});

  // ── Template settings columns ──────────────────────────────────
  const tmplCols = [
    'template_logo_url TEXT',
    'template_wm_url TEXT',
    'template_accent_color VARCHAR(20)',
    'template_bg_color VARCHAR(20)',
    'template_text_color VARCHAR(20)',
    'template_logo_line1 VARCHAR(100)',
    'template_logo_line2 VARCHAR(100)',
    'template_subtitle VARCHAR(200)',
    'template_contact_phone VARCHAR(100)',
    'template_contact_web VARCHAR(200)',
    'template_contact_social VARCHAR(200)',
  ];
  for (const col of tmplCols) {
    await client.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }

  // ── Prescriptions: link to records ─────────────────────────
  await client.query(`
    ALTER TABLE home_care_prescriptions
      ADD COLUMN IF NOT EXISTS record_id INTEGER REFERENCES records(id) ON DELETE SET NULL
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_hcp_record_id ON home_care_prescriptions(record_id)
  `).catch(() => {});

  // ── Daily Care Checklist: schedule fields ──────────────────
  await client.query(`
    ALTER TABLE home_care_prescriptions
      ADD COLUMN IF NOT EXISTS start_date DATE,
      ADD COLUMN IF NOT EXISTS end_date   DATE
  `).catch(() => {});

  // backfill старых prescription без start_date
  await client.query(`
    UPDATE home_care_prescriptions
       SET start_date = DATE(created_at)
     WHERE start_date IS NULL
  `).catch(() => {});

  // start_date NOT NULL после backfill
  await client.query(`
    ALTER TABLE home_care_prescriptions
      ALTER COLUMN start_date SET NOT NULL
  `).catch(() => {});

  await client.query(`
    ALTER TABLE home_care_items
      ADD COLUMN IF NOT EXISTS days_of_week SMALLINT[]
  `).catch(() => {});

  // ── Daily Care Checklist: completions log ──────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS home_care_completions (
      id              SERIAL PRIMARY KEY,
      item_id         INTEGER NOT NULL REFERENCES home_care_items(id) ON DELETE CASCADE,
      client_id       INTEGER NOT NULL REFERENCES clients(id)         ON DELETE CASCADE,
      completion_date DATE      NOT NULL,
      completed_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (item_id, client_id, completion_date)
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_hcc_client_date
      ON home_care_completions (client_id, completion_date DESC)
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_hcc_item_date
      ON home_care_completions (item_id, completion_date)
  `).catch(() => {});

  // ── Staff: show_in_app flag ────────────────────────────────
  await client.query(`
    ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS show_in_app BOOLEAN NOT NULL DEFAULT TRUE
  `).catch(() => {});

  // ── App Settings ───────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id           SERIAL PRIMARY KEY,
      clinic_name  TEXT NOT NULL DEFAULT '',
      logo_url     TEXT,
      phone        TEXT,
      whatsapp     TEXT,
      telegram     TEXT,
      instagram    TEXT,
      maps_url     TEXT,
      email        TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});

  // ── Mobile OTP Telegram delivery: phone ↔ chat_id link ──────
  await client.query(`
    CREATE TABLE IF NOT EXISTS mobile_telegram_links (
      phone       VARCHAR(20) PRIMARY KEY,
      chat_id     BIGINT NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_mobile_telegram_links_chat_id
      ON mobile_telegram_links(chat_id)
  `).catch(() => {});

  // ── Portfolio (До/После) tables ─────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS portfolio_categories (
      id              SERIAL PRIMARY KEY,
      salon_id        INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      title           VARCHAR(120) NOT NULL,
      cover_photo_url TEXT NOT NULL DEFAULT '',
      display_order   INTEGER NOT NULL DEFAULT 0,
      is_published    BOOLEAN NOT NULL DEFAULT TRUE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_portfolio_categories_salon_order
      ON portfolio_categories (salon_id, display_order)
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS portfolio_items (
      id                SERIAL PRIMARY KEY,
      salon_id          INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      category_id       INTEGER NOT NULL REFERENCES portfolio_categories(id) ON DELETE CASCADE,
      staff_id          INTEGER REFERENCES staff_members(id) ON DELETE SET NULL,
      title             VARCHAR(80) NOT NULL,
      description       VARCHAR(1000),
      photo_after_url   TEXT NOT NULL,
      photo_before_url  TEXT,
      display_order     INTEGER NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_portfolio_items_category_order
      ON portfolio_items (salon_id, category_id, display_order)
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_portfolio_items_staff
      ON portfolio_items (salon_id, staff_id) WHERE staff_id IS NOT NULL
  `).catch(() => {});
}

module.exports = { runMigrations };
