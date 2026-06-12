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

  // ── App Settings: MAX messenger field ──────────────────────────
  await client.query(`
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS max TEXT
  `).catch(() => {});

  // ── Salons: HMAC secret for YClients webhooks ──────────────────────
  // Per-salon secret used to verify the signature attached by YClients on
  // every webhook call. NULL means HMAC is not yet configured for this salon
  // (legacy mode — webhook accepted without signature). Once set, all
  // webhooks for that salon MUST carry a matching signature.
  await client.query(`
    ALTER TABLE salons ADD COLUMN IF NOT EXISTS yclients_webhook_secret VARCHAR(128)
  `).catch(() => {});

  // ── App Settings: per-salon scoping (closes cross-tenant write hole) ────
  // Before this, app_settings was a single global row that ANY salon's admin
  // could overwrite. Adding salon_id makes the table multi-tenant.
  await client.query(`
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salons(id) ON DELETE CASCADE
  `).catch(() => {});
  // Backfill: any pre-existing row gets attributed to the lowest salon id.
  await client.query(`
    UPDATE app_settings SET salon_id = (SELECT MIN(id) FROM salons)
    WHERE salon_id IS NULL
  `).catch(() => {});
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS app_settings_salon_id_unique
    ON app_settings (salon_id) WHERE salon_id IS NOT NULL
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

  // ── YClients goods catalog (Phase 03 — full product catalog from YClients) ──
  await client.query(`
    CREATE TABLE IF NOT EXISTS yclients_goods_catalog (
      id                BIGSERIAL PRIMARY KEY,
      salon_id          INTEGER     NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      yclients_good_id  BIGINT      NOT NULL,
      category_id       INTEGER,
      category_title    VARCHAR(200),
      title             VARCHAR(500) NOT NULL DEFAULT '',
      article           VARCHAR(200),
      last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_archived       BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (salon_id, yclients_good_id)
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_ygc_salon_active_cat
      ON yclients_goods_catalog (salon_id, category_title)
      WHERE NOT is_archived
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_ygc_salon_last_seen
      ON yclients_goods_catalog (salon_id, last_seen_at)
  `).catch(() => {});

  // ── Revenue Operations (multi-source revenue tracking) ──────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS revenue_operations (
      id                    SERIAL PRIMARY KEY,
      salon_id              INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      yclients_operation_id BIGINT NOT NULL,
      category              VARCHAR(32) NOT NULL,
      amount                NUMERIC(12,2) NOT NULL,
      operation_date        DATE NOT NULL,
      operation_at          TIMESTAMPTZ NOT NULL,
      client_id             INT REFERENCES clients(id) ON DELETE SET NULL,
      yclients_client_id    BIGINT,
      yclients_record_id    BIGINT,
      expense_id            INT,
      expense_title         VARCHAR(128),
      sold_item_type        VARCHAR(32),
      account_title         VARCHAR(128),
      is_cash               BOOLEAN,
      raw_payload           JSONB,
      source                VARCHAR(32) NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(salon_id, yclients_operation_id)
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_revenue_ops_salon_date
      ON revenue_operations(salon_id, operation_date)
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_revenue_ops_salon_cat_date
      ON revenue_operations(salon_id, category, operation_date)
  `).catch(() => {});

  // ── Widen source column to VARCHAR(32) if it was created as VARCHAR(16) ──
  await client.query(`
    ALTER TABLE revenue_operations
      ALTER COLUMN source TYPE VARCHAR(32)
  `).catch(() => {});

  // «На кого записана продажа» — master_id товарной транзакции YClients
  // (webhook finances_operation отдаёт master=[] всегда; реальная атрибуция
  // продажи товара/абонемента живёт в goods_transaction.master_id).
  await client.query(`
    ALTER TABLE revenue_operations
      ADD COLUMN IF NOT EXISTS sold_by_yc_staff_id INT
  `).catch(() => {});

  // ── Session tables: back the JWT-revocation check ──────────────
  // Auth (routes/index.js, middleware/mobile-auth.js) now requires every token
  // to map to a live row here, so logout / forced sign-out can revoke a JWT
  // before its expiry. These tables predate migrations.js on existing servers;
  // create them IF NOT EXISTS so a fresh deploy (e.g. prod) doesn't lock out
  // every login the moment the revocation check goes live.
  await client.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER,
      token      VARCHAR(512) NOT NULL UNIQUE,
      ip         VARCHAR(64),
      user_agent TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_token   ON sessions(token)`).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS mobile_sessions (
      id         SERIAL PRIMARY KEY,
      client_id  INTEGER NOT NULL,
      token      TEXT NOT NULL UNIQUE,
      phone      VARCHAR(32) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL
    )
  `).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_mobile_sessions_client_id  ON mobile_sessions(client_id)`).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_mobile_sessions_expires_at ON mobile_sessions(expires_at)`).catch(() => {});

  // ── Mobile OTP: per-code failed-attempt counter ────────────────
  // The 6-digit OTP is the sole auth factor for mobile clients. We cap
  // failed guesses per issued code (see routes/mobile-auth.js) so the code
  // space can't be brute-forced — even if an attacker rotates source IPs.
  await client.query(`
    CREATE TABLE IF NOT EXISTS mobile_otp_sessions (
      phone      VARCHAR(32) PRIMARY KEY,
      otp        VARCHAR(16) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL
    )
  `).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_mobile_otp_sessions_expires_at ON mobile_otp_sessions(expires_at)`).catch(() => {});
  await client.query(`
    ALTER TABLE mobile_otp_sessions ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0
  `).catch(() => {});

  // ── Patient Photo Cases (внутренний клинический модуль) ─────────
  // Спека:  docs/superpowers/specs/2026-05-30-patient-photo-cases-design.md
  // План:   docs/superpowers/plans/2026-05-30-patient-photo-cases.md  (Task 2)
  // ENUM создаём через DO-блок: CREATE TYPE ... IF NOT EXISTS появилось только в PG14.
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'case_photo_stage') THEN
        CREATE TYPE case_photo_stage AS ENUM ('before','in_progress','after');
      END IF;
    END $$;
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS case_courses (
      id          SERIAL PRIMARY KEY,
      salon_id    INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      title       VARCHAR(200) NOT NULL,
      description TEXT,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_case_courses_client ON case_courses (salon_id, client_id)`).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS case_visits (
      id                 SERIAL PRIMARY KEY,
      salon_id           INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      client_id          INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      record_id          INTEGER REFERENCES records(id) ON DELETE SET NULL,
      course_id          INTEGER REFERENCES case_courses(id) ON DELETE SET NULL,
      specialist_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      visit_date         DATE NOT NULL,
      notes              TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_case_visits_record ON case_visits (salon_id, record_id) WHERE record_id IS NOT NULL`).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_case_visits_client_date ON case_visits (salon_id, client_id, visit_date DESC)`).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_case_visits_course ON case_visits (course_id) WHERE course_id IS NOT NULL`).catch(() => {});
  // Лента «Фото-кейсы» (/visits/recent): WHERE salon_id ORDER BY created_at DESC, id DESC
  await client.query(`CREATE INDEX IF NOT EXISTS idx_case_visits_salon_created ON case_visits (salon_id, created_at DESC, id DESC)`).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS case_photos (
      id              BIGSERIAL PRIMARY KEY,
      salon_id        INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      case_visit_id   INTEGER NOT NULL REFERENCES case_visits(id) ON DELETE CASCADE,
      stage           case_photo_stage NOT NULL,
      s3_key_original TEXT NOT NULL,
      s3_key_medium   TEXT NOT NULL,
      s3_key_thumb    TEXT NOT NULL,
      mime_type       VARCHAR(50) NOT NULL,
      size_bytes      INTEGER NOT NULL,
      width           INTEGER,
      height          INTEGER,
      uploaded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sort_order      INTEGER NOT NULL DEFAULT 0
    )
  `).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_case_photos_visit_stage ON case_photos (case_visit_id, stage, sort_order)`).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS case_comments (
      id             BIGSERIAL PRIMARY KEY,
      salon_id       INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      case_visit_id  INTEGER NOT NULL REFERENCES case_visits(id) ON DELETE CASCADE,
      author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      text           TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_case_comments_visit ON case_comments (case_visit_id, created_at)`).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS s3_orphans (
      id         BIGSERIAL PRIMARY KEY,
      bucket     VARCHAR(100) NOT NULL,
      s3_key     TEXT NOT NULL,
      reason     VARCHAR(40),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempts   INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )
  `).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_s3_orphans_pending ON s3_orphans (created_at) WHERE attempts < 5`).catch(() => {});

  // ── Personal Staff Dashboard ───────────────────────────────────
  // Спека: docs/superpowers/specs/2026-06-01-staff-dashboard-design.md
  // План:  docs/superpowers/plans/2026-06-01-staff-dashboard.md (Task 1)
  await client.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS staff_member_id INTEGER
      REFERENCES staff_members(id) ON DELETE SET NULL
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_users_staff_member
      ON users (staff_member_id) WHERE staff_member_id IS NOT NULL
  `).catch(() => {});

  // ── Staff monthly goals («Цель месяца») ────────────────────────
  // month — всегда 1-е число месяца. Планы в ₽: услуги и товары раздельно.
  await client.query(`
    CREATE TABLE IF NOT EXISTS staff_goals (
      id SERIAL PRIMARY KEY,
      salon_id INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      staff_member_id INTEGER NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
      month DATE NOT NULL,
      services_target NUMERIC(12,2) NOT NULL DEFAULT 0,
      goods_target NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (salon_id, staff_member_id, month)
    )
  `).catch(() => {});

  // Коррелированные подзапросы по клиенту (перезапись, возвращаемость в
  // staff-dashboard) без этого индекса делают seq scan на каждый визит —
  // эндпоинт деградировал до 10-15 секунд.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_records_salon_yc_client
      ON records (salon_id, yclients_client_id)
  `).catch(() => {});
}

module.exports = { runMigrations };
