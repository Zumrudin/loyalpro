# Patient Photo Cases — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать модуль "Фото-кейсы пациентов" по спеке `docs/superpowers/specs/2026-05-30-patient-photo-cases-design.md`. Внутренний staff-only инструмент клинической фотодокументации: до/в процессе/после по визитам YClients, привязка к специалисту, опциональные курсы лечения, плоский тред комментариев, поиск по пациенту. Хранилище фото — российский S3 (Яндекс Object Storage), pay-as-you-go.

**Architecture:** Один новый модуль (`routes/patient-portfolio.js` + `services/patient-portfolio.js` + `services/s3.js`) + 4 миграции в `backend/migrations.js`. Frontend — одна страница `frontend/js/pages/patient-portfolio.js` с тремя уровнями навигации. Бэкенд резайзит через `sharp`, кладёт 3 варианта (thumb 300 / medium 1200 / original) в приватный S3, метаданные — в Postgres, отдача через pre-signed URLs (TTL 15 мин). Один cron на чистку зависших S3-объектов.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg` pool), `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `sharp`, `multer`, Jest (unit + integration с `aws-sdk-client-mock`), vanilla JS (фронт).

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `backend/package.json` | Modify | + `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `sharp`; devDep `aws-sdk-client-mock` |
| `backend/config.js` | Modify | Добавить S3-env vars + `SPECIALIST_ALLOWED_PREFIXES` пополнить `/api/patient-portfolio` |
| `backend/migrations.js` | Modify | 4 таблицы + ENUM + `s3_orphans` |
| `backend/services/s3.js` | **Create** | Тонкий S3-клиент: `putObject`, `deleteObjects`, `presignGet` |
| `backend/services/patient-portfolio.js` | **Create** | Pure helpers + upload pipeline (`sharp` → 3 варианта → S3) + atomic insert/rollback |
| `backend/patient-portfolio-helpers.test.js` | **Create** | Jest unit tests для всех чистых функций |
| `backend/patient-portfolio-pipeline.test.js` | **Create** | Jest integration tests для upload pipeline с замоканным S3 |
| `backend/routes/patient-portfolio.js` | **Create** | 15 эндпоинтов: courses / visits / photos / comments / search |
| `backend/routes/index.js` | Modify | Mount `/api/patient-portfolio` |
| `backend/server.js` | Modify | Зарегистрировать cron `processS3Orphans` (раз в сутки) |
| `backend/scripts/patient-cases-smoke.js` | **Create** | Прод-смок: загрузить → проверить URL → удалить |
| `frontend/index.html` | Modify | Контейнер `<div id="page-patient-portfolio">` + пункт меню |
| `frontend/js/core/nav.js` | Modify | Регистрация маршрута `#patient-portfolio` |
| `frontend/js/pages/patient-portfolio.js` | **Create** | Страница с 3 уровнями: поиск → карточка → альбом |
| `frontend/css/base.css` | Modify | Минимум новых стилей: `.case-card`, `.stage-grid`, `.lightbox` |
| `.env.example` | Modify | Шаблон S3-переменных |

---

## Pre-flight (manual, outside this plan)

Перед запуском плана нужно вручную:

1. Создать **бакет** в Яндекс Object Storage (или Selectel/Beget/VK), приватный, SSE-S3 on, versioning off:
   - dev:  `loyalpro-cases-dev`
   - prod: `loyalpro-cases-prod`
2. Создать **сервис-аккаунт + ключ** с IAM-политикой только на этот бакет; получить `ACCESS_KEY` и `SECRET_KEY`.
3. Положить в `backend/.env` (dev) и `/root/loyalpro_new/backend/.env` (prod):
   ```
   S3_ENDPOINT=https://storage.yandexcloud.net
   S3_REGION=ru-central1
   S3_BUCKET=loyalpro-cases-dev    # на проде заменить на -prod
   S3_ACCESS_KEY=...
   S3_SECRET_KEY=...
   S3_FORCE_PATH_STYLE=true
   S3_URL_TTL_SECONDS=900
   ```
4. Передать готовность с прикреплёнными credentials → можно запускать Task 1.

---

## Task 1: Install dependencies

**Files:**
- Modify: `backend/package.json`
- Modify: `.env.example`

- [ ] **Step 1:** В `backend/` запустить:
  ```bash
  cd backend
  npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner sharp
  npm install --save-dev aws-sdk-client-mock
  ```

- [ ] **Step 2:** Убедиться, что `sharp` собрался без ошибок:
  ```bash
  node -e "const sharp = require('sharp'); console.log('sharp ok, libvips', sharp.versions.vips)"
  ```
  Ожидается строка вида `sharp ok, libvips 8.x.x`. Если ошибка про prebuilt-binary — `npm install --include=optional sharp` либо `apt-get install libvips-dev` и переустановка.

- [ ] **Step 3:** Обновить `.env.example` — добавить блок:
  ```
  # S3 (patient photo cases)
  S3_ENDPOINT=https://storage.yandexcloud.net
  S3_REGION=ru-central1
  S3_BUCKET=loyalpro-cases-dev
  S3_ACCESS_KEY=
  S3_SECRET_KEY=
  S3_FORCE_PATH_STYLE=true
  S3_URL_TTL_SECONDS=900
  ```

- [ ] **Step 4:** Commit:
  ```bash
  git add backend/package.json backend/package-lock.json .env.example
  git commit -m "deps: add aws-sdk + sharp for patient photo cases"
  ```

---

## Task 2: DB migration (4 tables + ENUM + s3_orphans)

**Files:**
- Modify: `backend/migrations.js`

- [ ] **Step 1:** Найти точку вставки — конец функции `runMigrations`:
  ```bash
  grep -n "^}\|module.exports" backend/migrations.js | tail -5
  ```
  Вставляем новый блок **перед** закрывающим `}` функции.

- [ ] **Step 2:** Добавить блок миграций:
  ```js
    // ── Patient Photo Cases (внутренний клинический модуль) ─────────
    // ENUM создаём отдельно — IF NOT EXISTS у CREATE TYPE появилось в PG14;
    // делаем через DO-блок для совместимости.
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
  ```

- [ ] **Step 3:** Запустить миграции локально:
  ```bash
  cd backend && node -e "
  const { runMigrations } = require('./migrations');
  const { pool } = require('./db');
  pool.connect().then(c => runMigrations(c).then(() => { c.release(); console.log('OK'); pool.end(); })).catch(e => { console.error(e); process.exit(1); });
  "
  ```
  Ожидается `OK`. Проверить таблицы через `mcp__postgres__query`:
  ```sql
  SELECT table_name FROM information_schema.tables
  WHERE table_name IN ('case_courses','case_visits','case_photos','case_comments','s3_orphans')
  ORDER BY table_name;
  ```
  Ожидается 5 строк.

- [ ] **Step 4:** Commit:
  ```bash
  git add backend/migrations.js
  git commit -m "feat(db): tables for patient photo cases (cases/visits/photos/comments/orphans)"
  ```

---

## Task 3: Unit tests for pure helpers (TDD red)

**Files:**
- Create: `backend/patient-portfolio-helpers.test.js`

- [ ] **Step 1:** Создать тест-файл с покрытием:
  - `buildS3Key(salonId, clientId, visitId, photoId, variant)` — детерминированная сборка ключа
  - `parseStage(input)` — валидация enum, отклонение мусора
  - `normalizePhone(raw)` — последние 10 цифр, `+7…`/`8…`/пробелы/скобки
  - `pickThumbForCard(photosArray)` — приоритет `after` → `in_progress` → `before` → `null`
  - `assertCanMutate(user, ownerUserId)` — 6 кейсов (owner/admin/specialist × свой/чужой)

  ```js
  // backend/patient-portfolio-helpers.test.js
  'use strict';
  const {
    buildS3Key, parseStage, normalizePhone, pickThumbForCard, assertCanMutate
  } = require('./services/patient-portfolio');

  describe('buildS3Key', () => {
    test('собирает ключ по схеме salon/client/visit/photo_variant', () => {
      expect(buildS3Key(1, 42, 7, 100, 'orig'))
        .toBe('salon_1/client_42/visit_7/100_orig.jpg');
      expect(buildS3Key(1, 42, 7, 100, 'med'))
        .toBe('salon_1/client_42/visit_7/100_med.jpg');
      expect(buildS3Key(1, 42, 7, 100, 'thumb'))
        .toBe('salon_1/client_42/visit_7/100_thumb.jpg');
    });
    test('бросает на невалидный variant', () => {
      expect(() => buildS3Key(1, 1, 1, 1, 'huge')).toThrow();
    });
  });

  describe('parseStage', () => {
    test.each(['before','in_progress','after'])('принимает %s', (s) => {
      expect(parseStage(s)).toBe(s);
    });
    test('тримит и нижний регистр', () => {
      expect(parseStage('  AFTER ')).toBe('after');
    });
    test.each([null, undefined, '', 'maybe', 'до', 42])('отклоняет %p', (v) => {
      expect(() => parseStage(v)).toThrow();
    });
  });

  describe('normalizePhone', () => {
    test.each([
      ['+7 (999) 123-45-67', '9991234567'],
      ['8(999)1234567',      '9991234567'],
      ['79991234567',        '9991234567'],
      ['9991234567',         '9991234567'],
    ])('%s → %s', (raw, expected) => {
      expect(normalizePhone(raw)).toBe(expected);
    });
    test('возвращает null на короткое', () => {
      expect(normalizePhone('123')).toBeNull();
    });
  });

  describe('pickThumbForCard', () => {
    const photo = (stage, id) => ({ stage, id, s3_key_thumb: `t${id}` });
    test('предпочитает after', () => {
      expect(pickThumbForCard([photo('before',1), photo('after',2), photo('in_progress',3)]).id).toBe(2);
    });
    test('падает на in_progress если нет after', () => {
      expect(pickThumbForCard([photo('before',1), photo('in_progress',3)]).id).toBe(3);
    });
    test('берёт before если только он есть', () => {
      expect(pickThumbForCard([photo('before',1)]).id).toBe(1);
    });
    test('null на пустом массиве', () => {
      expect(pickThumbForCard([])).toBeNull();
    });
  });

  describe('assertCanMutate', () => {
    const ownerOk = (role) => { assertCanMutate({ id: 5, role }, 99); };       // другой автор
    const selfOk  = (role) => { assertCanMutate({ id: 5, role }, 5);  };       // свой
    test('owner всегда может', () => { expect(() => ownerOk('owner')).not.toThrow(); });
    test('admin всегда может', () => { expect(() => ownerOk('admin')).not.toThrow(); });
    test('specialist на своём — ок', () => { expect(() => selfOk('specialist')).not.toThrow(); });
    test('specialist на чужом — 403', () => { expect(() => ownerOk('specialist')).toThrow(/Forbidden|Only the author/); });
    test('owner на NULL author — ок', () => { expect(() => assertCanMutate({ id: 5, role: 'owner' }, null)).not.toThrow(); });
    test('specialist на NULL author — 403', () => { expect(() => assertCanMutate({ id: 5, role: 'specialist' }, null)).toThrow(); });
  });
  ```

- [ ] **Step 2:** Прогнать — должно **упасть** (модуля ещё нет):
  ```bash
  cd backend && npx jest patient-portfolio-helpers
  ```
  Ожидается ошибка `Cannot find module './services/patient-portfolio'`.

- [ ] **Step 3:** Commit:
  ```bash
  git add backend/patient-portfolio-helpers.test.js
  git commit -m "test: failing unit tests for patient-portfolio pure helpers"
  ```

---

## Task 4: Implement pure helpers (TDD green)

**Files:**
- Create: `backend/services/patient-portfolio.js`

- [ ] **Step 1:** Создать модуль со скелетом (без upload pipeline пока):
  ```js
  // backend/services/patient-portfolio.js
  'use strict';

  const STAGES = new Set(['before','in_progress','after']);
  const VARIANT_SUFFIX = { orig: 'orig', med: 'med', thumb: 'thumb' };

  function buildS3Key(salonId, clientId, visitId, photoId, variant) {
    const suffix = VARIANT_SUFFIX[variant];
    if (!suffix) throw new Error(`invalid s3 variant: ${variant}`);
    return `salon_${salonId}/client_${clientId}/visit_${visitId}/${photoId}_${suffix}.jpg`;
  }

  function parseStage(input) {
    if (typeof input !== 'string') throw new Error('stage must be a string');
    const s = input.trim().toLowerCase();
    if (!STAGES.has(s)) throw new Error(`invalid stage: ${input}`);
    return s;
  }

  function normalizePhone(raw) {
    if (raw == null) return null;
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length < 10) return null;
    return digits.slice(-10);
  }

  function pickThumbForCard(photos) {
    if (!Array.isArray(photos) || photos.length === 0) return null;
    const by = (stage) => photos.find(p => p.stage === stage);
    return by('after') || by('in_progress') || by('before') || null;
  }

  class ForbiddenError extends Error {
    constructor(msg = 'Forbidden') { super(msg); this.statusCode = 403; }
  }

  function assertCanMutate(user, ownerUserId) {
    if (!user) throw new ForbiddenError();
    if (user.role === 'owner' || user.role === 'admin') return;
    if (ownerUserId != null && user.id === ownerUserId) return;
    throw new ForbiddenError('Only the author or admin can modify this');
  }

  module.exports = {
    buildS3Key,
    parseStage,
    normalizePhone,
    pickThumbForCard,
    assertCanMutate,
    ForbiddenError,
  };
  ```

- [ ] **Step 2:** Прогнать — должно **зелёным**:
  ```bash
  cd backend && npx jest patient-portfolio-helpers
  ```
  Ожидается все тесты passed.

- [ ] **Step 3:** Commit:
  ```bash
  git add backend/services/patient-portfolio.js
  git commit -m "feat: pure helpers for patient portfolio (s3-key/stage/phone/thumb/auth)"
  ```

---

## Task 5: S3 client wrapper

**Files:**
- Create: `backend/services/s3.js`
- Modify: `backend/config.js`

- [ ] **Step 1:** Добавить env-vars в `config.js`:
  ```js
  // в module.exports добавить:
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_REGION: process.env.S3_REGION || 'ru-central1',
  S3_BUCKET: process.env.S3_BUCKET,
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY,
  S3_SECRET_KEY: process.env.S3_SECRET_KEY,
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE === 'true',
  S3_URL_TTL_SECONDS: parseInt(process.env.S3_URL_TTL_SECONDS) || 900,
  ```

- [ ] **Step 2:** Расширить `SPECIALIST_ALLOWED_PREFIXES`:
  ```js
  SPECIALIST_ALLOWED_PREFIXES: ['/api/home-care', '/api/auth', '/api/template-settings', '/api/patient-portfolio'],
  ```

- [ ] **Step 3:** Создать `services/s3.js`:
  ```js
  // backend/services/s3.js
  'use strict';
  const { S3Client, PutObjectCommand, DeleteObjectsCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const cfg = require('../config');

  const client = new S3Client({
    endpoint: cfg.S3_ENDPOINT,
    region: cfg.S3_REGION,
    credentials: { accessKeyId: cfg.S3_ACCESS_KEY, secretAccessKey: cfg.S3_SECRET_KEY },
    forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
  });

  async function putObject(key, body, contentType = 'image/jpeg') {
    await client.send(new PutObjectCommand({
      Bucket: cfg.S3_BUCKET, Key: key, Body: body, ContentType: contentType,
    }));
  }

  async function deleteObjects(keys) {
    if (!keys || keys.length === 0) return { deleted: [], errors: [] };
    const res = await client.send(new DeleteObjectsCommand({
      Bucket: cfg.S3_BUCKET,
      Delete: { Objects: keys.map(k => ({ Key: k })), Quiet: false },
    }));
    return { deleted: (res.Deleted || []).map(d => d.Key), errors: (res.Errors || []) };
  }

  async function presignGet(key, ttlSeconds = cfg.S3_URL_TTL_SECONDS) {
    return getSignedUrl(client, new GetObjectCommand({ Bucket: cfg.S3_BUCKET, Key: key }), { expiresIn: ttlSeconds });
  }

  module.exports = { client, putObject, deleteObjects, presignGet };
  ```

- [ ] **Step 4:** Smoke-проверка модуля (требует валидных S3-кредов и существующего бакета):
  ```bash
  cd backend && node -e "
  const s3 = require('./services/s3');
  (async () => {
    const key = '_smoke/' + Date.now() + '.txt';
    await s3.putObject(key, Buffer.from('hello'), 'text/plain');
    console.log('PUT ok');
    const url = await s3.presignGet(key);
    console.log('URL:', url.slice(0, 100) + '...');
    const r = await s3.deleteObjects([key]);
    console.log('DEL ok', r);
  })().catch(e => { console.error(e); process.exit(1); });
  "
  ```
  Если падает — проверить `.env` (см. Pre-flight).

- [ ] **Step 5:** Commit:
  ```bash
  git add backend/services/s3.js backend/config.js
  git commit -m "feat: S3 client wrapper (put/delete/presign) + specialist prefix"
  ```

---

## Task 6: Integration test for upload pipeline (TDD red)

**Files:**
- Create: `backend/patient-portfolio-pipeline.test.js`

- [ ] **Step 1:** Создать тест с мокированным S3 и фейковым 1×1 PNG-буфером:
  ```js
  // backend/patient-portfolio-pipeline.test.js
  'use strict';
  const { mockClient } = require('aws-sdk-client-mock');
  const { S3Client, PutObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
  const sharp = require('sharp');

  // Подменяем S3Client глобально ДО require пайплайна
  const s3Mock = mockClient(S3Client);

  describe('uploadPhoto pipeline', () => {
    let svc;
    beforeAll(async () => {
      svc = require('./services/patient-portfolio');
    });
    beforeEach(() => { s3Mock.reset(); });

    async function makeJpeg(width=2000, height=1500) {
      return sharp({ create: { width, height, channels: 3, background: '#888' } })
        .jpeg().toBuffer();
    }

    test('генерирует 3 варианта и кладёт в S3', async () => {
      s3Mock.on(PutObjectCommand).resolves({});
      const buf = await makeJpeg();
      const result = await svc.processAndUpload({
        salonId: 1, clientId: 42, visitId: 7, photoId: 100,
        buffer: buf, mimeType: 'image/jpeg',
      });
      const puts = s3Mock.commandCalls(PutObjectCommand);
      expect(puts).toHaveLength(3);
      const keys = puts.map(c => c.args[0].input.Key).sort();
      expect(keys).toEqual([
        'salon_1/client_42/visit_7/100_med.jpg',
        'salon_1/client_42/visit_7/100_orig.jpg',
        'salon_1/client_42/visit_7/100_thumb.jpg',
      ]);
      expect(result).toMatchObject({
        s3_key_original: 'salon_1/client_42/visit_7/100_orig.jpg',
        s3_key_medium:   'salon_1/client_42/visit_7/100_med.jpg',
        s3_key_thumb:    'salon_1/client_42/visit_7/100_thumb.jpg',
        width: 2000, height: 1500, mime_type: 'image/jpeg',
      });
      expect(result.size_bytes).toBeGreaterThan(0);
    });

    test('откатывает уже загруженные при сбое одного из PUT', async () => {
      // Первый PUT успешен, второй падает
      s3Mock.on(PutObjectCommand)
        .resolvesOnce({})
        .rejectsOnce(new Error('S3 down'))
        .resolves({});
      s3Mock.on(DeleteObjectsCommand).resolves({ Deleted: [] });
      const buf = await makeJpeg(800, 600);

      await expect(svc.processAndUpload({
        salonId: 1, clientId: 42, visitId: 7, photoId: 101,
        buffer: buf, mimeType: 'image/jpeg',
      })).rejects.toThrow();

      // Должна быть попытка batch-delete уже загруженных
      const dels = s3Mock.commandCalls(DeleteObjectsCommand);
      expect(dels.length).toBeGreaterThanOrEqual(1);
    });

    test('снимает EXIF', async () => {
      s3Mock.on(PutObjectCommand).resolves({});
      // Соберём JPEG с фейковым EXIF (через sharp.withMetadata())
      const withExif = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#fff' } })
        .withMetadata({ exif: { IFD0: { Software: 'TEST_EXIF_MARKER' } } })
        .jpeg().toBuffer();
      await svc.processAndUpload({
        salonId: 1, clientId: 1, visitId: 1, photoId: 200,
        buffer: withExif, mimeType: 'image/jpeg',
      });
      // Считываем то, что мы передали в PutObject для original
      const origPut = s3Mock.commandCalls(PutObjectCommand)
        .find(c => c.args[0].input.Key.endsWith('_orig.jpg'));
      const sentBody = origPut.args[0].input.Body;
      const meta = await sharp(sentBody).metadata();
      // EXIF блок должен отсутствовать
      expect(meta.exif).toBeUndefined();
    });

    test('бросает на не-картинку', async () => {
      await expect(svc.processAndUpload({
        salonId: 1, clientId: 1, visitId: 1, photoId: 300,
        buffer: Buffer.from('not an image'), mimeType: 'image/jpeg',
      })).rejects.toThrow();
    });
  });
  ```

- [ ] **Step 2:** Прогнать — должно **упасть** (функции `processAndUpload` ещё нет):
  ```bash
  cd backend && npx jest patient-portfolio-pipeline
  ```

- [ ] **Step 3:** Commit:
  ```bash
  git add backend/patient-portfolio-pipeline.test.js
  git commit -m "test: failing integration tests for patient-portfolio upload pipeline"
  ```

---

## Task 7: Implement upload pipeline (TDD green)

**Files:**
- Modify: `backend/services/patient-portfolio.js`

- [ ] **Step 1:** Добавить в модуль (до `module.exports`):
  ```js
  const sharp = require('sharp');
  const s3 = require('./s3');

  /**
   * Полный пайплайн обработки одного фото:
   *   1) sharp.rotate() — выровнять по EXIF
   *   2) 3 варианта (original re-encode, medium 1200, thumb 300), EXIF снят дефолтом
   *   3) 3× PutObject в S3 параллельно
   *   4) на ошибке — DeleteObjects уже залитых
   * Возвращает поля для INSERT в case_photos.
   */
  async function processAndUpload({ salonId, clientId, visitId, photoId, buffer, mimeType }) {
    let meta;
    try {
      meta = await sharp(buffer, { failOn: 'truncated' }).metadata();
      if (!meta || !meta.width || !meta.height) throw new Error('not an image');
    } catch (e) {
      const err = new Error(`Invalid image: ${e.message}`);
      err.statusCode = 400;
      throw err;
    }

    const img = sharp(buffer).rotate();   // выравнивание по EXIF Orientation, метаданные не сохраняем
    const [originalBuf, mediumBuf, thumbBuf] = await Promise.all([
      img.clone().jpeg({ quality: 92, mozjpeg: true }).toBuffer(),
      img.clone().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
                 .jpeg({ quality: 85, mozjpeg: true }).toBuffer(),
      img.clone().resize({ width: 300, height: 300, fit: 'cover' })
                 .jpeg({ quality: 80, mozjpeg: true }).toBuffer(),
    ]);

    const keys = {
      original: buildS3Key(salonId, clientId, visitId, photoId, 'orig'),
      medium:   buildS3Key(salonId, clientId, visitId, photoId, 'med'),
      thumb:    buildS3Key(salonId, clientId, visitId, photoId, 'thumb'),
    };

    const uploaded = [];
    try {
      await Promise.all([
        s3.putObject(keys.original, originalBuf).then(() => uploaded.push(keys.original)),
        s3.putObject(keys.medium,   mediumBuf  ).then(() => uploaded.push(keys.medium)),
        s3.putObject(keys.thumb,    thumbBuf   ).then(() => uploaded.push(keys.thumb)),
      ]);
    } catch (e) {
      // Откат: пытаемся удалить уже залитое; ошибки удаления глотаем (cron подберёт).
      try { await s3.deleteObjects(uploaded); } catch (_) { /* ignored */ }
      const err = new Error(`S3 upload failed: ${e.message}`);
      err.statusCode = 502;
      throw err;
    }

    return {
      s3_key_original: keys.original,
      s3_key_medium:   keys.medium,
      s3_key_thumb:    keys.thumb,
      mime_type: 'image/jpeg',   // всегда после re-encode
      size_bytes: originalBuf.length,
      width:  meta.width,
      height: meta.height,
    };
  }
  ```

- [ ] **Step 2:** Добавить в `module.exports`:
  ```js
  module.exports = { /* ... existing ..., */ processAndUpload };
  ```

- [ ] **Step 3:** Прогнать тесты пайплайна — должно быть **зелёным**:
  ```bash
  cd backend && npx jest patient-portfolio-pipeline
  ```

- [ ] **Step 4:** Также прогнать helpers-тесты — убедиться, что не сломали:
  ```bash
  cd backend && npx jest patient-portfolio
  ```

- [ ] **Step 5:** Commit:
  ```bash
  git add backend/services/patient-portfolio.js
  git commit -m "feat: upload pipeline — sharp 3 variants + atomic S3 put/rollback"
  ```

---

## Task 8: Routes — все 15 эндпоинтов в одном файле

**Files:**
- Create: `backend/routes/patient-portfolio.js`

Этот task создаёт весь роутер целиком — 15 эндпоинтов по спеке. Длинный, но плотный.

- [ ] **Step 1:** Создать `routes/patient-portfolio.js`:
  ```js
  'use strict';
  const express = require('express');
  const multer = require('multer');
  const { db } = require('../db');
  const svc = require('../services/patient-portfolio');
  const s3 = require('../services/s3');
  const logger = require('../logger');   // если есть; иначе console

  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 20 },
    fileFilter: (_req, file, cb) => {
      const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
      cb(ok ? null : new Error('Unsupported file type'), ok);
    },
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const sid = (req) => req.user.salon_id;

  // ─── Helpers ──────────────────────────────────────────────────────
  async function loadVisit(visitId, salonId) {
    const v = await db.oneOrNone(
      `SELECT * FROM case_visits WHERE id=$1 AND salon_id=$2`, [visitId, salonId]);
    if (!v) { const e = new Error('Not found'); e.statusCode = 404; throw e; }
    return v;
  }
  async function loadPhoto(photoId, salonId) {
    const p = await db.oneOrNone(
      `SELECT * FROM case_photos WHERE id=$1 AND salon_id=$2`, [photoId, salonId]);
    if (!p) { const e = new Error('Not found'); e.statusCode = 404; throw e; }
    return p;
  }

  // ─── COURSES ──────────────────────────────────────────────────────
  router.get('/clients/:clientId/courses', wrap(async (req, res) => {
    const rows = await db.any(`
      SELECT c.*,
             COALESCE(json_agg(
               json_build_object('id', v.id, 'visit_date', v.visit_date)
               ORDER BY v.visit_date DESC
             ) FILTER (WHERE v.id IS NOT NULL), '[]'::json) AS visits
      FROM case_courses c
      LEFT JOIN case_visits v ON v.course_id = c.id
      WHERE c.salon_id=$1 AND c.client_id=$2
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `, [sid(req), req.params.clientId]);
    res.json(rows);
  }));

  router.post('/courses', wrap(async (req, res) => {
    const { client_id, title, description } = req.body;
    if (!client_id || !title) { res.status(400).json({ error: 'client_id and title required' }); return; }
    const row = await db.one(`
      INSERT INTO case_courses (salon_id, client_id, title, description, created_by)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [sid(req), client_id, title, description || null, req.user.id]);
    res.status(201).json(row);
  }));

  router.put('/courses/:id', wrap(async (req, res) => {
    const c = await db.oneOrNone(`SELECT * FROM case_courses WHERE id=$1 AND salon_id=$2`, [req.params.id, sid(req)]);
    if (!c) { res.status(404).end(); return; }
    svc.assertCanMutate(req.user, c.created_by);
    const { title, description } = req.body;
    const row = await db.one(`
      UPDATE case_courses SET title=COALESCE($1,title), description=COALESCE($2,description), updated_at=NOW()
      WHERE id=$3 RETURNING *
    `, [title, description, req.params.id]);
    res.json(row);
  }));

  router.delete('/courses/:id', wrap(async (req, res) => {
    const c = await db.oneOrNone(`SELECT * FROM case_courses WHERE id=$1 AND salon_id=$2`, [req.params.id, sid(req)]);
    if (!c) { res.status(404).end(); return; }
    svc.assertCanMutate(req.user, c.created_by);
    await db.query(`DELETE FROM case_courses WHERE id=$1`, [req.params.id]);
    res.status(204).end();
  }));

  // ─── VISITS (cases) ───────────────────────────────────────────────
  router.get('/clients/:clientId/cases', wrap(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const before = req.query.before;   // YYYY-MM-DD keyset
    const params = [sid(req), req.params.clientId];
    let where = `salon_id=$1 AND client_id=$2`;
    if (before && /^\d{4}-\d{2}-\d{2}$/.test(before)) {
      params.push(before); where += ` AND visit_date < $3::date`;
    }
    params.push(limit);
    const rows = await db.any(`
      SELECT v.*, u.name AS specialist_name,
             c.title AS course_title,
             (SELECT COUNT(*)::int FROM case_photos p WHERE p.case_visit_id = v.id) AS photos_count,
             (SELECT COUNT(*)::int FROM case_comments cm WHERE cm.case_visit_id = v.id) AS comments_count
      FROM case_visits v
      LEFT JOIN users u ON u.id = v.specialist_user_id
      LEFT JOIN case_courses c ON c.id = v.course_id
      WHERE ${where}
      ORDER BY visit_date DESC, v.id DESC
      LIMIT $${params.length}
    `, params);

    // Превью thumb на карточку — по 1 фото с приоритетом after→in_progress→before
    for (const v of rows) {
      const photos = await db.any(
        `SELECT id, stage, s3_key_thumb FROM case_photos WHERE case_visit_id=$1`, [v.id]);
      const pick = svc.pickThumbForCard(photos);
      v.preview_url = pick ? await s3.presignGet(pick.s3_key_thumb) : null;
    }
    res.json(rows);
  }));

  router.get('/visits/:id', wrap(async (req, res) => {
    const v = await loadVisit(req.params.id, sid(req));
    const photos = await db.any(`
      SELECT id, stage, s3_key_thumb, s3_key_medium, width, height, sort_order, uploaded_by, uploaded_at
      FROM case_photos WHERE case_visit_id=$1
      ORDER BY stage, sort_order, id
    `, [v.id]);
    for (const p of photos) {
      p.url_thumb  = await s3.presignGet(p.s3_key_thumb);
      p.url_medium = await s3.presignGet(p.s3_key_medium);
    }
    const comments = await db.any(`
      SELECT cm.*, u.name AS author_name
      FROM case_comments cm LEFT JOIN users u ON u.id = cm.author_user_id
      WHERE cm.case_visit_id=$1 ORDER BY cm.created_at
    `, [v.id]);
    res.json({ ...v, photos, comments });
  }));

  router.post('/visits', wrap(async (req, res) => {
    const { client_id, record_id, course_id, notes } = req.body;
    if (!client_id) { res.status(400).json({ error: 'client_id required' }); return; }
    // Идемпотентность: если record_id уже занят — вернуть существующий
    if (record_id) {
      const ex = await db.oneOrNone(
        `SELECT * FROM case_visits WHERE salon_id=$1 AND record_id=$2`, [sid(req), record_id]);
      if (ex) { res.json(ex); return; }
    }
    const visitDate = record_id
      ? (await db.oneOrNone(`SELECT COALESCE((visit_datetime AT TIME ZONE 'Europe/Moscow')::date, visit_date::date) AS d FROM records WHERE id=$1`, [record_id]))?.d
      : new Date().toISOString().slice(0,10);
    const row = await db.one(`
      INSERT INTO case_visits (salon_id, client_id, record_id, course_id, specialist_user_id, visit_date, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [sid(req), client_id, record_id || null, course_id || null, req.user.id, visitDate, notes || null]);
    res.status(201).json(row);
  }));

  router.put('/visits/:id', wrap(async (req, res) => {
    const v = await loadVisit(req.params.id, sid(req));
    svc.assertCanMutate(req.user, v.specialist_user_id);
    const { notes, course_id } = req.body;
    const row = await db.one(`
      UPDATE case_visits SET notes=COALESCE($1,notes), course_id=$2, updated_at=NOW()
      WHERE id=$3 RETURNING *
    `, [notes, course_id || null, v.id]);
    res.json(row);
  }));

  router.delete('/visits/:id', wrap(async (req, res) => {
    const v = await loadVisit(req.params.id, sid(req));
    svc.assertCanMutate(req.user, v.specialist_user_id);
    const keys = await db.any(`
      SELECT s3_key_original, s3_key_medium, s3_key_thumb FROM case_photos WHERE case_visit_id=$1
    `, [v.id]);
    await db.query(`DELETE FROM case_visits WHERE id=$1`, [v.id]);   // CASCADE на photos/comments
    const allKeys = keys.flatMap(k => [k.s3_key_original, k.s3_key_medium, k.s3_key_thumb]);
    if (allKeys.length) {
      try { await s3.deleteObjects(allKeys); }
      catch (e) {
        for (const k of allKeys) {
          await db.query(`INSERT INTO s3_orphans (bucket, s3_key, reason, last_error) VALUES ($1,$2,$3,$4)`,
            [require('../config').S3_BUCKET, k, 'visit_delete', e.message]);
        }
      }
    }
    res.status(204).end();
  }));

  // ─── PHOTOS ───────────────────────────────────────────────────────
  router.post('/visits/:id/photos', upload.array('files', 20), wrap(async (req, res) => {
    const v = await loadVisit(req.params.id, sid(req));
    const stage = svc.parseStage(req.body.stage);
    if (!req.files || req.files.length === 0) { res.status(400).json({ error: 'no files' }); return; }

    const results = [];
    // Последовательно, чтобы не убить RAM sharp-ом
    for (const f of req.files) {
      const { rows: [{ id: photoId }] } = await db.query(`SELECT nextval('case_photos_id_seq') AS id`);
      let meta;
      try {
        meta = await svc.processAndUpload({
          salonId: sid(req), clientId: v.client_id, visitId: v.id, photoId,
          buffer: f.buffer, mimeType: f.mimetype,
        });
      } catch (e) {
        // Откат уже сделан внутри processAndUpload
        results.push({ ok: false, error: e.message });
        continue;
      }
      const row = await db.one(`
        INSERT INTO case_photos (id, salon_id, case_visit_id, stage,
          s3_key_original, s3_key_medium, s3_key_thumb,
          mime_type, size_bytes, width, height, uploaded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING id
      `, [photoId, sid(req), v.id, stage,
          meta.s3_key_original, meta.s3_key_medium, meta.s3_key_thumb,
          meta.mime_type, meta.size_bytes, meta.width, meta.height, req.user.id]);
      const urls = {
        thumb:  await s3.presignGet(meta.s3_key_thumb),
        medium: await s3.presignGet(meta.s3_key_medium),
      };
      results.push({ ok: true, id: row.id, urls });
    }
    const failed = results.filter(r => !r.ok);
    if (failed.length && results.every(r => !r.ok)) {
      res.status(502).json({ error: 'All uploads failed', results });
      return;
    }
    res.status(201).json({ uploaded: results });
  }));

  router.put('/photos/:id', wrap(async (req, res) => {
    const p = await loadPhoto(req.params.id, sid(req));
    svc.assertCanMutate(req.user, p.uploaded_by);
    const stage = req.body.stage !== undefined ? svc.parseStage(req.body.stage) : p.stage;
    const sort = req.body.sort_order !== undefined ? parseInt(req.body.sort_order) : p.sort_order;
    const row = await db.one(`
      UPDATE case_photos SET stage=$1, sort_order=$2 WHERE id=$3 RETURNING *
    `, [stage, sort, p.id]);
    res.json(row);
  }));

  router.delete('/photos/:id', wrap(async (req, res) => {
    const p = await loadPhoto(req.params.id, sid(req));
    svc.assertCanMutate(req.user, p.uploaded_by);
    await db.query(`DELETE FROM case_photos WHERE id=$1`, [p.id]);
    const keys = [p.s3_key_original, p.s3_key_medium, p.s3_key_thumb];
    try { await s3.deleteObjects(keys); }
    catch (e) {
      for (const k of keys) {
        await db.query(`INSERT INTO s3_orphans (bucket, s3_key, reason, last_error) VALUES ($1,$2,$3,$4)`,
          [require('../config').S3_BUCKET, k, 'photo_delete', e.message]);
      }
    }
    res.status(204).end();
  }));

  router.get('/photos/:id/url', wrap(async (req, res) => {
    const p = await loadPhoto(req.params.id, sid(req));
    const variant = req.query.variant || 'medium';
    const key = variant === 'original' ? p.s3_key_original
              : variant === 'medium'   ? p.s3_key_medium
              : variant === 'thumb'    ? p.s3_key_thumb
              : null;
    if (!key) { res.status(400).json({ error: 'invalid variant' }); return; }
    res.json({ url: await s3.presignGet(key), expires_in: require('../config').S3_URL_TTL_SECONDS });
  }));

  // ─── COMMENTS ────────────────────────────────────────────────────
  router.post('/visits/:id/comments', wrap(async (req, res) => {
    const v = await loadVisit(req.params.id, sid(req));
    const text = (req.body.text || '').trim();
    if (!text) { res.status(400).json({ error: 'text required' }); return; }
    const row = await db.one(`
      INSERT INTO case_comments (salon_id, case_visit_id, author_user_id, text)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [sid(req), v.id, req.user.id, text]);
    res.status(201).json(row);
  }));

  router.delete('/comments/:id', wrap(async (req, res) => {
    const c = await db.oneOrNone(`SELECT * FROM case_comments WHERE id=$1 AND salon_id=$2`, [req.params.id, sid(req)]);
    if (!c) { res.status(404).end(); return; }
    svc.assertCanMutate(req.user, c.author_user_id);
    await db.query(`DELETE FROM case_comments WHERE id=$1`, [c.id]);
    res.status(204).end();
  }));

  // ─── SEARCH ──────────────────────────────────────────────────────
  router.get('/search', wrap(async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) { res.json([]); return; }
    const phone = svc.normalizePhone(q);
    const params = [sid(req), `%${q}%`];
    let where = `c.salon_id=$1 AND c.name ILIKE $2`;
    if (phone) { params.push(`%${phone}%`); where = `c.salon_id=$1 AND (c.name ILIKE $2 OR c.phone ILIKE $3)`; }
    const rows = await db.any(`
      SELECT c.id, c.name, c.phone,
             (SELECT COUNT(*)::int FROM case_visits v WHERE v.client_id=c.id AND v.salon_id=c.salon_id) AS cases_count,
             (SELECT MAX(v.visit_date) FROM case_visits v WHERE v.client_id=c.id AND v.salon_id=c.salon_id) AS last_visit
      FROM clients c
      WHERE ${where}
      ORDER BY last_visit DESC NULLS LAST, c.name
      LIMIT 50
    `, params);
    res.json(rows.filter(r => r.cases_count > 0));
  }));

  // ─── ERROR HANDLER ───────────────────────────────────────────────
  router.use((err, _req, res, _next) => {
    const status = err.statusCode || 500;
    logger.error?.(`patient-portfolio error: ${err.message}`) || console.error(err);
    res.status(status).json({ error: err.message });
  });

  module.exports = router;
  ```

- [ ] **Step 2:** Запустить весь jest — убедиться, что новый файл не сломал помимо тестов:
  ```bash
  cd backend && npx jest
  ```

- [ ] **Step 3:** Commit:
  ```bash
  git add backend/routes/patient-portfolio.js
  git commit -m "feat(api): patient photo cases — 15 endpoints (courses/visits/photos/comments/search)"
  ```

---

## Task 9: Mount router + register cron

**Files:**
- Modify: `backend/routes/index.js`
- Modify: `backend/server.js`

- [ ] **Step 1:** В `routes/index.js` добавить mount:
  ```bash
  grep -n "router.use\|require('./" backend/routes/index.js | head -20
  ```
  По шаблону существующих:
  ```js
  router.use('/api/patient-portfolio', auth, require('./patient-portfolio'));
  ```
  (Если `auth` уже глобален в этом файле — просто `router.use('/api/patient-portfolio', require('./patient-portfolio'))`.)

- [ ] **Step 2:** Добавить функцию-cron в `services/patient-portfolio.js`:
  ```js
  async function processS3Orphans(db, s3) {
    const rows = await db.any(`SELECT id, s3_key FROM s3_orphans WHERE attempts < 5 ORDER BY created_at LIMIT 200`);
    if (rows.length === 0) return { processed: 0 };
    let ok = 0, fail = 0;
    for (const r of rows) {
      try {
        await s3.deleteObjects([r.s3_key]);
        await db.query(`DELETE FROM s3_orphans WHERE id=$1`, [r.id]);
        ok++;
      } catch (e) {
        await db.query(`UPDATE s3_orphans SET attempts = attempts + 1, last_error = $1 WHERE id=$2`, [e.message, r.id]);
        fail++;
      }
    }
    return { processed: rows.length, ok, fail };
  }
  module.exports.processS3Orphans = processS3Orphans;
  ```

- [ ] **Step 3:** В `backend/server.js` зарегистрировать cron рядом с существующими:
  ```js
  const { processS3Orphans } = require('./services/patient-portfolio');
  const s3 = require('./services/s3');
  const { db } = require('./db');

  cron.schedule('17 3 * * *', async () => {
    try {
      const r = await processS3Orphans(db, s3);
      logger.info(`s3 orphans: ${JSON.stringify(r)}`);
    } catch (e) { logger.error(`s3 orphans cron failed: ${e.message}`); }
  }, { timezone: 'Europe/Moscow' });
  ```

- [ ] **Step 4:** Перезапустить локальный dev и пройти ручной чек-лист (с открытым клиентом из БД):
  ```bash
  cd backend && npm run dev
  # в отдельном окне:
  TOKEN=...   # JWT админа дев-салона
  curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/patient-portfolio/search?q=ив   # ожидать [] или клиентов
  ```

- [ ] **Step 5:** Commit:
  ```bash
  git add backend/routes/index.js backend/server.js backend/services/patient-portfolio.js
  git commit -m "feat: mount /api/patient-portfolio + daily s3_orphans cron"
  ```

---

## Task 10: Frontend — навигация + Level 1 (поиск)

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/core/nav.js`
- Create: `frontend/js/pages/patient-portfolio.js`
- Modify: `frontend/css/base.css`

- [ ] **Step 1:** В `frontend/index.html` добавить пункт меню и контейнер. Найти существующее меню (`nav`/`sidebar`/`menu`) — добавить:
  ```html
  <a href="#patient-portfolio" data-route="patient-portfolio">📷 Фото-кейсы</a>
  ```
  Контейнер страницы (рядом с другими `page-*`):
  ```html
  <section id="page-patient-portfolio" class="page" hidden>
    <div class="pp-root"></div>
  </section>
  ```

- [ ] **Step 2:** В `nav.js` зарегистрировать маршрут (по шаблону существующих):
  ```js
  '#patient-portfolio': () => import('../pages/patient-portfolio.js').then(m => m.init()),
  ```
  (или CommonJS-вариант, если на проекте без модулей — смотреть `nav.js`.)

- [ ] **Step 3:** Скелет `frontend/js/pages/patient-portfolio.js`:
  ```js
  import { api } from '../core/api.js';

  const root = () => document.querySelector('#page-patient-portfolio .pp-root');

  let state = { level: 1, clientId: null, visitId: null, filterOnlyMine: false };

  export async function init() {
    document.querySelector('#page-patient-portfolio').hidden = false;
    await render();
  }

  async function render() {
    if (state.level === 3) return renderAlbum();
    if (state.level === 2) return renderPatient();
    return renderSearch();
  }

  // ── Level 1: поиск пациента ─────────────────────────────────
  async function renderSearch() {
    root().innerHTML = `
      <div class="pp-search">
        <input class="pp-q" placeholder="Поиск пациента по имени или телефону">
        <label><input type="checkbox" id="pp-mine"> Только мои</label>
      </div>
      <div class="pp-recent">Загрузка…</div>
    `;
    const inp = root().querySelector('.pp-q');
    let t;
    inp.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => doSearch(inp.value), 250);
    });
    root().querySelector('#pp-mine').addEventListener('change', (e) => {
      state.filterOnlyMine = e.target.checked;
      doSearch(inp.value);
    });
    doSearch('');
  }

  async function doSearch(q) {
    const out = root().querySelector('.pp-recent');
    if (!q) {
      // показываем «недавних с кейсами» — используем тот же search с пустым q
      // → backend вернёт [] на пустом q; для MVP покажем подсказку
      out.innerHTML = `<div class="pp-hint">Начните вводить имя или телефон</div>`;
      return;
    }
    const list = await api.get(`/api/patient-portfolio/search?q=${encodeURIComponent(q)}`);
    if (!list.length) { out.innerHTML = `<div class="pp-hint">Ничего не найдено</div>`; return; }
    out.innerHTML = list.map(c => `
      <div class="case-card" data-client-id="${c.id}">
        <div class="cc-name">${escapeHtml(c.name)}</div>
        <div class="cc-meta">${c.phone || ''} • ${c.cases_count} кейсов</div>
      </div>
    `).join('');
    out.querySelectorAll('.case-card').forEach(el => {
      el.addEventListener('click', () => {
        state.level = 2; state.clientId = parseInt(el.dataset.clientId);
        render();
      });
    });
  }

  // ── Level 2 / 3 — заглушки, реализуются в Task 11/12 ─────────
  async function renderPatient() {
    root().innerHTML = `<div>TODO: карточка пациента ${state.clientId}</div>`;
  }
  async function renderAlbum() {
    root().innerHTML = `<div>TODO: альбом ${state.visitId}</div>`;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  ```

- [ ] **Step 4:** Добавить минимум стилей в `frontend/css/base.css`:
  ```css
  .pp-search { display:flex; gap:12px; padding:16px; }
  .pp-q { flex:1; padding:8px 12px; }
  .pp-recent { display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:12px; padding:0 16px 16px; }
  .case-card { padding:12px; border:1px solid var(--border, #ddd); border-radius:8px; cursor:pointer; }
  .case-card:hover { background: var(--hover, #f5f5f5); }
  .cc-name { font-weight:600; }
  .cc-meta { color: var(--t2, #888); font-size:13px; margin-top:4px; }
  .pp-hint { color: var(--t2, #888); padding:16px; }
  ```

- [ ] **Step 5:** Прогнать локально: открыть `http://localhost:3001/#patient-portfolio`, ввести имя — увидеть результаты (или «Ничего не найдено», если БД девовая пустая по кейсам).

- [ ] **Step 6:** Commit:
  ```bash
  git add frontend/index.html frontend/js/core/nav.js frontend/js/pages/patient-portfolio.js frontend/css/base.css
  git commit -m "feat(ui): patient photo cases — search level (L1)"
  ```

---

## Task 11: Frontend — Level 2 (карточка пациента, таймлайн альбомов, курсы)

**Files:**
- Modify: `frontend/js/pages/patient-portfolio.js`
- Modify: `frontend/css/base.css`

- [ ] **Step 1:** Реализовать `renderPatient()`:
  ```js
  async function renderPatient() {
    const [cases, courses] = await Promise.all([
      api.get(`/api/patient-portfolio/clients/${state.clientId}/cases`),
      api.get(`/api/patient-portfolio/clients/${state.clientId}/courses`),
    ]);
    root().innerHTML = `
      <div class="pp-toolbar">
        <button class="btn-back">← Назад</button>
        <button class="btn-pri btn-new-visit">+ Новый альбом</button>
        <button class="btn-new-course">+ Курс</button>
      </div>
      <div class="pp-grid">
        <aside class="pp-courses">
          <h3>Курсы</h3>
          ${courses.length === 0 ? '<div class="pp-hint">Курсов нет</div>' :
            courses.map(c => `
              <div class="course-card" data-id="${c.id}">
                <div class="cc-name">${escapeHtml(c.title)}</div>
                <div class="cc-meta">${c.visits.length} визитов</div>
              </div>
            `).join('')}
        </aside>
        <main class="pp-timeline">
          ${cases.length === 0 ? '<div class="pp-hint">Кейсов пока нет</div>' :
            cases.map(v => `
              <div class="case-card" data-visit-id="${v.id}">
                ${v.preview_url ? `<img class="cc-preview" src="${v.preview_url}">` : '<div class="cc-noimg">нет фото</div>'}
                <div class="cc-body">
                  <div class="cc-name">${v.visit_date}</div>
                  <div class="cc-meta">${escapeHtml(v.specialist_name || '—')} • ${v.photos_count} фото • ${v.comments_count} комм.</div>
                  ${v.course_title ? `<div class="cc-course">↳ ${escapeHtml(v.course_title)}</div>` : ''}
                </div>
              </div>
            `).join('')}
        </main>
      </div>
    `;
    root().querySelector('.btn-back').onclick = () => { state.level = 1; render(); };
    root().querySelector('.btn-new-visit').onclick = () => openNewVisitModal();
    root().querySelector('.btn-new-course').onclick = () => openNewCourseModal();
    root().querySelectorAll('.case-card[data-visit-id]').forEach(el =>
      el.onclick = () => { state.level = 3; state.visitId = parseInt(el.dataset.visitId); render(); });
  }

  async function openNewCourseModal() {
    const title = prompt('Название курса:');
    if (!title) return;
    const description = prompt('Описание (опционально):') || null;
    await api.post('/api/patient-portfolio/courses', { client_id: state.clientId, title, description });
    render();
  }

  async function openNewVisitModal() {
    // MVP: запросить ближайший незакрытый record за 7 дней
    const recent = await api.get(`/api/records?client_id=${state.clientId}&from=${daysAgo(7)}&status=arrived,confirmed&limit=5`)
      .catch(() => ({ records: [] }));
    let recordId = null;
    if (recent.records && recent.records.length) {
      const r = recent.records[0];
      if (confirm(`Привязать к визиту ${r.visit_date} (${r.specialist_name || '—'})?`)) recordId = r.id;
    }
    await api.post('/api/patient-portfolio/visits', { client_id: state.clientId, record_id: recordId });
    render();
  }

  function daysAgo(n) {
    const d = new Date(); d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }
  ```

- [ ] **Step 2:** Стили для grid + preview:
  ```css
  .pp-toolbar { display:flex; gap:8px; padding:12px 16px; align-items:center; }
  .pp-toolbar .btn-back { background:none; border:0; color:var(--accent); cursor:pointer; }
  .pp-grid { display:grid; grid-template-columns:240px 1fr; gap:16px; padding:0 16px 16px; }
  .pp-courses h3 { margin:0 0 8px 0; font-size:14px; color:var(--t2); }
  .course-card { padding:8px 10px; border:1px solid var(--border); border-radius:6px; margin-bottom:6px; cursor:pointer; }
  .pp-timeline { display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:12px; }
  .cc-preview { width:100%; height:140px; object-fit:cover; border-radius:6px 6px 0 0; }
  .cc-noimg { width:100%; height:140px; background:var(--bg2); display:grid; place-items:center; color:var(--t2); border-radius:6px 6px 0 0; }
  .cc-body { padding:8px 10px; }
  .cc-course { color:var(--accent); font-size:12px; margin-top:2px; }
  ```

- [ ] **Step 3:** Локально проверить: создать клиента + визит в YClients dev, открыть → должен показать пустой список → создать альбом через «+ Новый альбом» → должен появиться.

- [ ] **Step 4:** Commit:
  ```bash
  git add frontend/js/pages/patient-portfolio.js frontend/css/base.css
  git commit -m "feat(ui): patient card with timeline + courses (L2)"
  ```

---

## Task 12: Frontend — Level 3 (альбом + 3 стадии + загрузка + лайтбокс + комментарии)

**Files:**
- Modify: `frontend/js/pages/patient-portfolio.js`
- Modify: `frontend/css/base.css`

- [ ] **Step 1:** Реализовать `renderAlbum()`:
  ```js
  async function renderAlbum() {
    const v = await api.get(`/api/patient-portfolio/visits/${state.visitId}`);
    const byStage = { before: [], in_progress: [], after: [] };
    v.photos.forEach(p => byStage[p.stage].push(p));
    const stageBlock = (stageKey, label) => `
      <section class="stage-block">
        <header><h3>${label}</h3>
          <label class="btn-add">
            + Добавить фото
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple capture="environment" data-stage="${stageKey}" hidden>
          </label>
        </header>
        <div class="stage-grid">
          ${byStage[stageKey].map(p => `<img src="${p.url_thumb}" data-photo-id="${p.id}" data-medium="${p.url_medium}">`).join('')}
        </div>
      </section>
    `;
    root().innerHTML = `
      <div class="pp-toolbar">
        <button class="btn-back">← Назад к пациенту</button>
        <div class="pp-meta">${v.visit_date} • ${v.notes ? escapeHtml(v.notes.slice(0,80)) : ''}</div>
        <button class="btn-del-visit">Удалить альбом</button>
      </div>
      ${stageBlock('before', 'До')}
      ${stageBlock('in_progress', 'В процессе')}
      ${stageBlock('after', 'После')}
      <section class="notes-block">
        <h3>Заметки</h3>
        <textarea class="visit-notes">${escapeHtml(v.notes || '')}</textarea>
      </section>
      <section class="comments-block">
        <h3>Комментарии</h3>
        <div class="comments-list">
          ${v.comments.map(c => `
            <div class="comment">
              <div class="c-head">${escapeHtml(c.author_name || '—')} • ${new Date(c.created_at).toLocaleString('ru')}</div>
              <div class="c-text">${escapeHtml(c.text)}</div>
            </div>`).join('')}
        </div>
        <div class="comment-form">
          <textarea class="new-comment" placeholder="Написать комментарий…"></textarea>
          <button class="btn-pri btn-add-comment">Отправить</button>
        </div>
      </section>
      <div class="lightbox" hidden><img><button class="lb-close">×</button><button class="lb-dl">Скачать оригинал</button></div>
    `;

    root().querySelector('.btn-back').onclick = () => { state.level = 2; render(); };
    root().querySelector('.btn-del-visit').onclick = async () => {
      if (!confirm('Удалить альбом со всеми фото?')) return;
      await api.delete(`/api/patient-portfolio/visits/${v.id}`);
      state.level = 2; render();
    };

    // Заметки — autosave on blur
    root().querySelector('.visit-notes').addEventListener('blur', async (e) => {
      await api.put(`/api/patient-portfolio/visits/${v.id}`, { notes: e.target.value });
    });

    // Загрузка фото по стадии (по 5 в batch последовательно)
    root().querySelectorAll('input[type=file]').forEach(inp => {
      inp.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        const stage = inp.dataset.stage;
        for (let i = 0; i < files.length; i += 5) {
          const chunk = files.slice(i, i + 5);
          const fd = new FormData();
          fd.append('stage', stage);
          chunk.forEach(f => fd.append('files', f));
          await api.postFormData(`/api/patient-portfolio/visits/${v.id}/photos`, fd);
        }
        render();
      });
    });

    // Lightbox
    const lb = root().querySelector('.lightbox');
    root().querySelectorAll('.stage-grid img').forEach(img => {
      img.onclick = () => {
        lb.hidden = false;
        lb.querySelector('img').src = img.dataset.medium;
        lb.dataset.photoId = img.dataset.photoId;
      };
    });
    lb.querySelector('.lb-close').onclick = () => { lb.hidden = true; };
    lb.querySelector('.lb-dl').onclick = async () => {
      const r = await api.get(`/api/patient-portfolio/photos/${lb.dataset.photoId}/url?variant=original`);
      window.open(r.url);
    };

    // Комментарий
    root().querySelector('.btn-add-comment').onclick = async () => {
      const ta = root().querySelector('.new-comment');
      if (!ta.value.trim()) return;
      await api.post(`/api/patient-portfolio/visits/${v.id}/comments`, { text: ta.value });
      ta.value = '';
      render();
    };
  }
  ```

- [ ] **Step 2:** Если в `core/api.js` нет `postFormData` — добавить:
  ```js
  postFormData: (url, fd) => fetch(url, {
    method: 'POST', headers: { Authorization: `Bearer ${localStorage.token}` }, body: fd,
  }).then(r => r.ok ? r.json() : Promise.reject(r)),
  ```

- [ ] **Step 3:** Стили:
  ```css
  .stage-block { padding:12px 16px; border-top:1px solid var(--border); }
  .stage-block header { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
  .btn-add { cursor:pointer; padding:6px 12px; border:1px dashed var(--accent); border-radius:6px; }
  .stage-grid { display:grid; grid-template-columns:repeat(auto-fill, 120px); gap:8px; }
  .stage-grid img { width:120px; height:120px; object-fit:cover; border-radius:6px; cursor:pointer; }
  .notes-block, .comments-block { padding:12px 16px; border-top:1px solid var(--border); }
  .visit-notes { width:100%; min-height:60px; padding:8px; }
  .comment { padding:8px 0; border-bottom:1px solid var(--bg2); }
  .c-head { font-size:12px; color:var(--t2); }
  .c-text { margin-top:4px; white-space:pre-wrap; }
  .comment-form { display:flex; gap:8px; align-items:flex-start; margin-top:8px; }
  .new-comment { flex:1; min-height:50px; padding:8px; }
  .lightbox { position:fixed; inset:0; background:rgba(0,0,0,0.85); display:grid; place-items:center; z-index:1000; }
  .lightbox img { max-width:90vw; max-height:85vh; }
  .lb-close { position:absolute; top:12px; right:16px; font-size:36px; background:none; color:#fff; border:0; cursor:pointer; }
  .lb-dl { position:absolute; bottom:24px; left:50%; transform:translateX(-50%); padding:8px 16px; background:#fff; border:0; border-radius:6px; cursor:pointer; }
  ```

- [ ] **Step 4:** Локальный smoke с реальным S3-дев: открыть альбом → залить 2 тестовых JPEG в «До» → должны появиться thumbs → клик → lightbox → «Скачать оригинал» → новая вкладка с фото.

- [ ] **Step 5:** Commit:
  ```bash
  git add frontend/js/pages/patient-portfolio.js frontend/css/base.css frontend/js/core/api.js
  git commit -m "feat(ui): album view with 3 stages, upload widget, lightbox, comments (L3)"
  ```

---

## Task 13: Production smoke test

**Files:**
- Create: `backend/scripts/patient-cases-smoke.js`

- [ ] **Step 1:** Скрипт ходит по REST API целиком — create visit → upload 1 photo → verify URL → delete photo → delete visit. Использует существующий dev-JWT (берётся из env):
  ```js
  // backend/scripts/patient-cases-smoke.js
  'use strict';
  require('dotenv').config();
  const sharp = require('sharp');
  const BASE = process.env.SMOKE_BASE || 'http://localhost:3001';
  const TOKEN = process.env.SMOKE_TOKEN;       // JWT админа дев-салона
  const CLIENT_ID = parseInt(process.env.SMOKE_CLIENT_ID);   // существующий client_id

  if (!TOKEN || !CLIENT_ID) { console.error('SMOKE_TOKEN and SMOKE_CLIENT_ID required'); process.exit(1); }
  const H = { Authorization: `Bearer ${TOKEN}` };

  async function req(method, path, body, isForm = false) {
    const opts = { method, headers: { ...H } };
    if (body) {
      if (isForm) { opts.body = body; }
      else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    }
    const r = await fetch(`${BASE}${path}`, opts);
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${t}`);
    return t ? JSON.parse(t) : null;
  }

  (async () => {
    console.log('1) create visit');
    const v = await req('POST', '/api/patient-portfolio/visits', { client_id: CLIENT_ID });
    console.log('   visit id', v.id);

    console.log('2) upload 1 photo');
    const buf = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#cba' } }).jpeg().toBuffer();
    const fd = new FormData();
    fd.append('stage', 'before');
    fd.append('files', new Blob([buf], { type: 'image/jpeg' }), 'smoke.jpg');
    const u = await req('POST', `/api/patient-portfolio/visits/${v.id}/photos`, fd, true);
    console.log('   uploaded', u.uploaded[0].id);

    console.log('3) GET visit detail');
    const det = await req('GET', `/api/patient-portfolio/visits/${v.id}`);
    if (det.photos.length !== 1) throw new Error('expected 1 photo');
    const url = det.photos[0].url_thumb;
    const probe = await fetch(url);
    if (!probe.ok) throw new Error(`thumb URL not reachable: ${probe.status}`);
    console.log('   thumb 200 OK');

    console.log('4) delete photo');
    await req('DELETE', `/api/patient-portfolio/photos/${u.uploaded[0].id}`);

    console.log('5) delete visit');
    await req('DELETE', `/api/patient-portfolio/visits/${v.id}`);

    console.log('✅ smoke ok');
  })().catch(e => { console.error('❌', e.message); process.exit(1); });
  ```

- [ ] **Step 2:** Прогнать локально против dev-сервера:
  ```bash
  cd backend && SMOKE_TOKEN=... SMOKE_CLIENT_ID=... node scripts/patient-cases-smoke.js
  ```
  Ожидается `✅ smoke ok`.

- [ ] **Step 3:** Commit:
  ```bash
  git add backend/scripts/patient-cases-smoke.js
  git commit -m "test: production smoke script for patient photo cases"
  ```

---

## Task 14: Deploy

- [ ] **Step 1:** Push: `git push origin main`.

- [ ] **Step 2:** На прод-сервере:
  ```bash
  ssh root@217.114.0.254
  cd /root/loyalpro_new
  git pull origin main
  cd backend && npm install     # дотянуть aws-sdk + sharp
  pm2 restart loyalpro
  pm2 logs loyalpro --lines 50  # убедиться: миграции прошли, "sharp ok", cron зарегистрирован
  ```

- [ ] **Step 3:** Прогнать smoke на проде:
  ```bash
  cd /root/loyalpro_new/backend
  SMOKE_BASE=https://<your-prod-host> SMOKE_TOKEN=<prod-admin-jwt> SMOKE_CLIENT_ID=<real client> node scripts/patient-cases-smoke.js
  ```

- [ ] **Step 4:** Проверка вручную в браузере staff-SPA: открыть `Фото-кейсы` → найти реального пациента → создать альбом → залить 3 тестовых фото в «До» → убедиться, что thumb отображаются, лайтбокс работает, скачивание оригинала открывает новую вкладку.

- [ ] **Step 5:** Зафиксировать в `.planning/intel/` (если используется) или в новой записи памяти, что модуль развёрнут, бакет такой-то, env-vars там-то.

---

## Definition of Done

- ✅ Все 14 задач выполнены, каждая закоммичена отдельным atomic commit.
- ✅ `npx jest` в `backend/` зелёный (unit + integration).
- ✅ Smoke-скрипт прошёл на проде.
- ✅ Ручной чек-лист в браузере прошёл (поиск → карточка → альбом → загрузка → лайтбокс → комментарии → удаление).
- ✅ В `pm2 logs` нет ошибок при загрузке/удалении.
- ✅ В S3-бакете под `salon_<sid>/client_<cid>/visit_<vid>/` лежат 3 файла на фото.
- ✅ `s3_orphans` после удаления — пуст (или cron его подобрал).

## Откат (rollback) при критике на проде

```bash
ssh root@217.114.0.254
cd /root/loyalpro_new
git log --oneline -20                    # найти последний коммит ДО фичи
git revert <commit_hash_first_feature>..HEAD --no-commit && git commit -m "revert: patient photo cases"
pm2 restart loyalpro
```

Таблицы (`case_*`, `s3_orphans`) останутся в DB пустыми и никому не помешают — оставить.
Файлы из S3 (если успели загрузиться) — удалить руками из консоли провайдера или скриптом.
