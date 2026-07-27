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

  // Логотип филиала — используется как favicon веб-интерфейса
  await client.query(`
    ALTER TABLE salons ADD COLUMN IF NOT EXISTS logo_url VARCHAR(500)
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

  // ── База знаний (Knowledge Base) ───────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS kb_categories (
      id            SERIAL PRIMARY KEY,
      salon_id      INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      icon          TEXT NOT NULL DEFAULT '',
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS kb_categories_salon_order_idx
    ON kb_categories (salon_id, display_order)
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS kb_articles (
      id            SERIAL PRIMARY KEY,
      salon_id      INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      category_id   INTEGER NOT NULL REFERENCES kb_categories(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      body          TEXT NOT NULL DEFAULT '',
      tags          TEXT[] NOT NULL DEFAULT '{}',
      -- tags_text: теги плоской строкой (роут пишет tags.join(' ')). Нужно, т.к.
      -- array_to_string()/массив→текст в GENERATED-колонке не immutable — Postgres
      -- отвергает такое выражение. Обычная текстовая колонка immutable и стеммится.
      tags_text     TEXT NOT NULL DEFAULT '',
      is_published  BOOLEAN NOT NULL DEFAULT TRUE,
      display_order INTEGER NOT NULL DEFAULT 0,
      search_vector TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('russian'::regconfig, coalesce(title, '')),     'A') ||
        setweight(to_tsvector('russian'::regconfig, coalesce(body,  '')),     'B') ||
        setweight(to_tsvector('russian'::regconfig, coalesce(tags_text, '')), 'A')
      ) STORED,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS kb_articles_search_idx
    ON kb_articles USING GIN (search_vector)
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS kb_articles_salon_cat_order_idx
    ON kb_articles (salon_id, category_id, display_order)
  `).catch(() => {});

  // ── RAG-слой базы знаний (спека 2026-07-18-kb-rag-retrieval-design) ──
  // pgvector на Beget недоступен → эмбеддинг храним как real[], косинус в JS.
  await client.query(`
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id            SERIAL PRIMARY KEY,
      salon_id      INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      article_id    INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
      chunk_index   INTEGER NOT NULL,
      content       TEXT NOT NULL,
      content_hash  TEXT NOT NULL DEFAULT '',
      embedding     REAL[],
      embed_norm    REAL NOT NULL DEFAULT 0,
      search_vector TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('russian'::regconfig, coalesce(content, ''))
      ) STORED,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (article_id, chunk_index)
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS kb_chunks_search_idx
    ON kb_chunks USING GIN (search_vector)
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS kb_chunks_salon_idx
    ON kb_chunks (salon_id)
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS kb_article_links (
      id            SERIAL PRIMARY KEY,
      salon_id      INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      article_id    INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
      entity_type   TEXT NOT NULL CHECK (entity_type IN ('service','staff')),
      entity_yc_id  BIGINT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (article_id, entity_type, entity_yc_id)
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS kb_article_links_lookup_idx
    ON kb_article_links (salon_id, entity_type, entity_yc_id)
  `).catch(() => {});

  // ── База знаний: логи ИИ-ассистента ────────────────────────────
  // Спека: docs/superpowers/specs/2026-07-16-kb-ai-assistant-design.md
  await client.query(`
    CREATE TABLE IF NOT EXISTS kb_chat_logs (
      id          SERIAL PRIMARY KEY,
      salon_id    INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      question    TEXT NOT NULL,
      answer      TEXT NOT NULL DEFAULT '',
      source_ids  INTEGER[] NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS kb_chat_logs_salon_idx
    ON kb_chat_logs (salon_id, created_at DESC)
  `).catch(() => {});

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

  // ── Telegram broadcasts ────────────────────────────────────────
  // Рассылка сообщений подписчикам Telegram-бота. Очередь живёт в основной
  // БД (broadcasts + broadcast_recipients), а сам список подписчиков
  // подтягивается из botDb (n8n_db.clients_peri.tg_id) в момент создания.
  await client.query(`
    CREATE TABLE IF NOT EXISTS broadcasts (
      id                SERIAL PRIMARY KEY,
      salon_id          INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      author_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      message_template  TEXT NOT NULL,
      filters           JSONB NOT NULL DEFAULT '{}'::jsonb,
      status            VARCHAR(20) NOT NULL DEFAULT 'pending',
      total             INTEGER NOT NULL DEFAULT 0,
      sent              INTEGER NOT NULL DEFAULT 0,
      failed            INTEGER NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at        TIMESTAMPTZ,
      finished_at       TIMESTAMPTZ,
      cancel_requested  BOOLEAN NOT NULL DEFAULT FALSE,
      last_error        TEXT
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_broadcasts_salon_created
      ON broadcasts (salon_id, created_at DESC)
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_broadcasts_status
      ON broadcasts (status) WHERE status IN ('pending','in_progress')
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS broadcast_recipients (
      id                BIGSERIAL PRIMARY KEY,
      broadcast_id      INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
      client_id         INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      telegram_chat_id  BIGINT NOT NULL,
      client_name       VARCHAR(255),
      personalized_text TEXT NOT NULL,
      status            VARCHAR(20) NOT NULL DEFAULT 'pending',
      error             TEXT,
      sent_at           TIMESTAMPTZ
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_pending
      ON broadcast_recipients (broadcast_id, status)
  `).catch(() => {});

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_broadcast_recipient
      ON broadcast_recipients (broadcast_id, telegram_chat_id)
  `).catch(() => {});

  // ── Medical certificate (КНД 1151156) ──────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS medical_cert_templates (
      id          SERIAL PRIMARY KEY,
      salon_id    INTEGER REFERENCES salons(id) ON DELETE CASCADE,
      s3_key      TEXT NOT NULL,
      file_name   VARCHAR(255),
      version     INTEGER NOT NULL DEFAULT 1,
      is_active   BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS medical_cert_coords (
      template_id INTEGER PRIMARY KEY REFERENCES medical_cert_templates(id) ON DELETE CASCADE,
      coords      JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch(() => {});

  // ── Заявки на справку (самозаявка с сайта) ─────────────────────
  await client.query(`
    ALTER TABLE salons ADD COLUMN IF NOT EXISTS cert_request_slug VARCHAR(40)
  `).catch(() => {});
  // бэкфилл slug для салонов без значения: 'clinic-<id>'
  await client.query(`
    UPDATE salons SET cert_request_slug = 'clinic-' || id WHERE cert_request_slug IS NULL
  `).catch(() => {});
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS salons_cert_request_slug_uq
      ON salons(cert_request_slug)
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS cert_requests (
      id                        SERIAL PRIMARY KEY,
      salon_id                  INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      status                    VARCHAR(20) NOT NULL DEFAULT 'new',
      report_year               INTEGER NOT NULL,
      payer_is_patient          BOOLEAN NOT NULL,
      payer_last                VARCHAR(120),
      payer_first               VARCHAR(120),
      payer_middle              VARCHAR(120),
      payer_birthdate           DATE,
      payer_inn                 VARCHAR(12),
      payer_doc_type_code       VARCHAR(2),
      payer_doc_serie_number    VARCHAR(20),
      payer_doc_issue_date      DATE,
      payer_phone               VARCHAR(20),
      payer_email               VARCHAR(190),
      patient_last              VARCHAR(120),
      patient_first             VARCHAR(120),
      patient_middle            VARCHAR(120),
      patient_birthdate         DATE,
      patient_inn               VARCHAR(12),
      patient_doc_type_code     VARCHAR(2),
      patient_doc_serie_number  VARCHAR(20),
      patient_doc_issue_date    DATE,
      patient_phone             VARCHAR(20),
      relationship              VARCHAR(20),
      matched_client_id         INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      computed_amount           NUMERIC(12,2),
      consent_at                TIMESTAMPTZ NOT NULL,
      ip                        VARCHAR(64),
      user_agent                TEXT,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS cert_requests_salon_status_idx
      ON cert_requests(salon_id, status, created_at DESC)
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS cert_requests_salon_match_idx
      ON cert_requests(salon_id, matched_client_id)
      WHERE matched_client_id IS NOT NULL
  `).catch(() => {});

  // ── Разовый патч координат активных бланков (стр. 2 + перенос наименования) ──
  // Применяется один раз на шаблон (маркер _p2patch_v1), чтобы не затирать
  // ручную калибровку. Только добавляет недостающие поля / выравнивает секции.
  const tpls = (await client.query(
    `SELECT c.template_id, c.coords
       FROM medical_cert_coords c
       JOIN medical_cert_templates t ON t.id = c.template_id AND t.is_active`
  ).catch(() => ({ rows: [] }))).rows;
  for (const r of tpls) {
    const coords = r.coords;
    const f = coords && coords.fields;
    if (!f || coords._p2patch_v1) continue;
    // Наименование организации — перенос на вторую строку клеток (шаг строки ~23pt).
    if (f.org_name && f.org_name.wrapY == null) f.org_name.wrapY = f.org_name.y - 23;
    // ИНН/КПП организации в верхнем блоке стр. 2 (дублируются на каждом листе).
    if (f.org_inn && !f.org_inn_p2) f.org_inn_p2 = { ...f.org_inn, page: 1 };
    if (f.org_kpp && !f.org_kpp_p2) {
      // Сдвиг на клетку влево: 9-я цифра КПП не должна наезжать на «Стр.».
      f.org_kpp_p2 = { ...f.org_kpp, page: 1, x: f.org_kpp.x - (f.org_kpp.step || 14.3) };
    }
    // Серия/номер паспорта пациента — те же колонки, что на стр. 1 (раздельные секции).
    const align = (dst, src) => { if (f[dst] && f[src]) f[dst].x = f[src].x; };
    align('patient_serie1', 'doc_serie1');
    align('patient_serie2', 'doc_serie2');
    align('patient_number1', 'doc_number1');
    align('patient_number2', 'doc_number2');
    coords._p2patch_v1 = true;
    await client.query(
      `UPDATE medical_cert_coords SET coords = $1, updated_at = now() WHERE template_id = $2`,
      [coords, r.template_id]
    ).catch(() => {});
  }

  // ── Выравнивание: номер справки по правому краю, суммы — слева ──────────
  // Самонацеливается на известное «битое» состояние (точные значения текущего
  // бланка), поэтому идемпотентно и не трогает иначе откалиброванные шаблоны.
  for (const r of tpls) {
    const coords = r.coords;
    const f = coords && coords.fields;
    if (!f) continue;
    let changed = false;
    // Номер справки печатался по середине (anchorRight=185) → к правому краю поля.
    if (f.cert_number && f.cert_number.anchorRight === 185) {
      Object.assign(f.cert_number, { x: 88, step: 14.2, max: 12, align: 'right', anchorRight: 244 });
      changed = true;
    }
    // Суммы печатались по середине (align:right, anchorRight=470) → слева.
    for (const k of ['amount1_rub', 'amount2_rub']) {
      if (f[k] && f[k].align === 'right' && f[k].anchorRight === 470) {
        f[k] = { x: 329, y: f[k].y, step: 14.2, max: 13, type: 'cells', page: 0, fontSize: 11 };
        changed = true;
      }
    }
    if (changed) {
      await client.query(
        `UPDATE medical_cert_coords SET coords = $1, updated_at = now() WHERE template_id = $2`,
        [coords, r.template_id]
      ).catch(() => {});
    }
  }

  // ── Chatpush: приём входящих сообщений (мессенджер-агент) ───────────
  // chatpush_events — СЫРОЙ лог всех вебхуков (аудит + возможность переиграть).
  await client.query(`
    CREATE TABLE IF NOT EXISTS chatpush_events (
      id SERIAL PRIMARY KEY,
      salon_id INTEGER REFERENCES salons(id) ON DELETE CASCADE,
      customer_id INTEGER,
      type VARCHAR(50),
      direction VARCHAR(20),
      external_message_id VARCHAR(500),
      phone VARCHAR(32),
      payload JSONB NOT NULL,
      processed BOOLEAN DEFAULT FALSE,
      error TEXT,
      received_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_chatpush_events_received
      ON chatpush_events (salon_id, received_at DESC)
  `).catch(() => {});

  // chatpush_messages — нормализованные сообщения (входящие + исходящие-эхо).
  // client_id nullable: клиент может быть ещё не сматчен по номеру.
  await client.query(`
    CREATE TABLE IF NOT EXISTS chatpush_messages (
      id SERIAL PRIMARY KEY,
      salon_id INTEGER REFERENCES salons(id) ON DELETE CASCADE,
      client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      customer_id INTEGER,
      channel VARCHAR(30),
      direction VARCHAR(20),
      external_message_id VARCHAR(500),
      reply_to_message_id VARCHAR(500),
      msg_type VARCHAR(30),
      text TEXT,
      file_url TEXT,
      mime_type VARCHAR(120),
      sender_name VARCHAR(255),
      phone VARCHAR(32),
      chat_id VARCHAR(120),
      msg_ts BIGINT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (salon_id, external_message_id)
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_chatpush_messages_dialog
      ON chatpush_messages (salon_id, phone, msg_ts DESC)
  `).catch(() => {});
  // Индекс по выражению ключа диалога COALESCE(NULLIF(phone,''), chat_id) —
  // обслуживает группировку/сортировку в routes/chat.js (список диалогов),
  // включая каналы без phone (Telegram/MAX, ключ = chat_id).
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_chatpush_messages_dialogkey
      ON chatpush_messages (salon_id, (COALESCE(NULLIF(phone,''), chat_id)), msg_ts DESC)
  `).catch(() => {});
  // Индекс по ключу диалога v2 (группы отдельным тредом: 'g:'||chat_id) —
  // выражение обязано СИМВОЛ-В-СИМВОЛ совпадать с DIALOG_KEY_SQL из
  // services/chat.js, иначе планировщик его не возьмёт. Старый индекс
  // dialogkey оставлен: migrations.js только добавляет, не дропает.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_chatpush_messages_dialogkey2
      ON chatpush_messages (salon_id,
        (CASE WHEN chat_id LIKE '-%' THEN 'g:' || chat_id
              ELSE COALESCE(NULLIF(phone,''), chat_id) END),
        msg_ts DESC)
  `).catch(() => {});

  // agent_settings — настройки ИИ-агента по салону (вкл/выкл + режим допуска).
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_settings (
      salon_id INTEGER PRIMARY KEY REFERENCES salons(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      mode VARCHAR(20) NOT NULL DEFAULT 'all',
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});

  // agent_number_rules — белый/чёрный списки номеров для допуска агента.
  // phone хранится каноничным (только цифры, РФ 8→7) — см. services/agent-gate.
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_number_rules (
      id SERIAL PRIMARY KEY,
      salon_id INTEGER REFERENCES salons(id) ON DELETE CASCADE,
      phone VARCHAR(32) NOT NULL,
      rule_type VARCHAR(10) NOT NULL,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (salon_id, phone, rule_type)
    )
  `).catch(() => {});

  // service_mode — режим фильтра услуг агента (независим от mode для номеров).
  await client.query(`
    ALTER TABLE agent_settings
      ADD COLUMN IF NOT EXISTS service_mode VARCHAR(20) NOT NULL DEFAULT 'all'
  `).catch(() => {});

  // agent_service_rules — правила видимости услуг/пар услуга×мастер для агента.
  // yc_staff_id NULL = правило на услугу целиком; заполнен = пара услуга×мастер.
  // rule_type: 'deny' | 'allow'. Пары поддерживают только 'deny' (см. спеку).
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_service_rules (
      id            SERIAL PRIMARY KEY,
      salon_id      INTEGER REFERENCES salons(id) ON DELETE CASCADE,
      yc_service_id BIGINT NOT NULL,
      yc_staff_id   BIGINT NULL,
      rule_type     VARCHAR(10) NOT NULL,
      note          TEXT,
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_service_rules_uniq
      ON agent_service_rules (salon_id, yc_service_id, COALESCE(yc_staff_id, 0), rule_type)
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_service_rules_salon_idx
      ON agent_service_rules (salon_id)
  `).catch(() => {});

  // agent_service_subcategories — локальный оверлей-дерево подкатегорий поверх
  // плоских YClients-категорий. yc_category_id — ЯКОРЬ топ-категории всего
  // поддерева (денормализован на всех уровнях, наследуется от родителя), поэтому
  // путь категорий строится без обхода до корня. parent_id NULL = прямо под
  // YClients-категорией. Каскад по детям — ON DELETE CASCADE на parent_id.
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_service_subcategories (
      id             SERIAL PRIMARY KEY,
      salon_id       INTEGER REFERENCES salons(id) ON DELETE CASCADE,
      yc_category_id BIGINT NOT NULL,
      parent_id      INTEGER NULL REFERENCES agent_service_subcategories(id) ON DELETE CASCADE,
      title          TEXT NOT NULL,
      display_order  INTEGER NOT NULL DEFAULT 0,
      created_at     TIMESTAMP DEFAULT NOW(),
      updated_at     TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_service_subcategories_cat_idx
      ON agent_service_subcategories (salon_id, yc_category_id)
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_service_subcategories_parent_idx
      ON agent_service_subcategories (salon_id, parent_id)
  `).catch(() => {});

  // agent_service_placements — назначение услуги в подкатегорию (перемещение).
  // Нет строки → услуга в родной YClients-категории. UNIQUE (salon_id, yc_service_id):
  // услуга помещена максимум в ОДНУ подкатегорию. Удаление подкатегории каскадит
  // placements → услуги возвращаются в родную категорию.
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_service_placements (
      id             SERIAL PRIMARY KEY,
      salon_id       INTEGER REFERENCES salons(id) ON DELETE CASCADE,
      yc_service_id  BIGINT NOT NULL,
      subcategory_id INTEGER NOT NULL REFERENCES agent_service_subcategories(id) ON DELETE CASCADE,
      display_order  INTEGER NOT NULL DEFAULT 0,
      created_at     TIMESTAMP DEFAULT NOW(),
      updated_at     TIMESTAMP DEFAULT NOW(),
      UNIQUE (salon_id, yc_service_id)
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_service_placements_sub_idx
      ON agent_service_placements (salon_id, subcategory_id)
  `).catch(() => {});

  // agent_stop_topics — темы, которыми клиника не занимается ВООБЩЕ (даже не
  // консультирует). Отличается от agent_service_rules: там прячутся конкретные
  // yc_service_id, а здесь тема, которой в каталоге может не быть вовсе
  // (например «новообразования: родинки, папилломы»). В промпте имеет приоритет
  // над каталогом — иначе агент предложит смежную услугу в обход отказа.
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_stop_topics (
      id         SERIAL PRIMARY KEY,
      salon_id   INTEGER REFERENCES salons(id) ON DELETE CASCADE,
      topic      TEXT NOT NULL,
      note       TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_stop_topics_uniq
      ON agent_stop_topics (salon_id, lower(topic))
  `).catch(() => {});

  // ── Состояние диалога агента + аудит вызовов инструментов (спека booking-agent) ──
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_dialogs (
      id                SERIAL PRIMARY KEY,
      salon_id          INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      dialog_key        TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'bot' CHECK (status IN ('bot','escalated','closed')),
      collected         JSONB NOT NULL DEFAULT '{}'::jsonb,
      watermark_ts      BIGINT NOT NULL DEFAULT 0,
      dirty             BOOLEAN NOT NULL DEFAULT FALSE,
      escalated_reason  TEXT,
      assigned_operator INTEGER,
      last_activity     TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (salon_id, dialog_key)
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_dialogs_lookup_idx
    ON agent_dialogs (salon_id, dialog_key)
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id            SERIAL PRIMARY KEY,
      salon_id      INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      dialog_key    TEXT,
      kind          TEXT NOT NULL,
      tool_name     TEXT,
      payload       JSONB,
      idempotency_key TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_events_dialog_idx
    ON agent_events (salon_id, dialog_key, created_at DESC)
  `).catch(() => {});
  // Идемпотентность создания записи: один и тот же (dialog+service+datetime) — одна бронь.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_events_idem_idx
    ON agent_events (salon_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `).catch(() => {});
}

module.exports = { runMigrations };
