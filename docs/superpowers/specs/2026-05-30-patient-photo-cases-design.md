# Patient Photo Cases — Design Spec

**Дата:** 2026-05-30
**Статус:** Brainstormed, awaiting user review of this spec before implementation plan.
**Связанные модули:** существующий `portfolio` (До/После маркетинговая галерея — НЕ путать), `home_care_prescriptions` (похожий per-patient + per-specialist + per-record паттерн).

## 1. Цель

Дать клинике PERI (и любому салону на платформе LoyalPro) возможность вести **фотодокументацию работ с конкретным пациентом**: фото до / в процессе / после каждого визита, привязка к визиту YClients, выбор специалиста-автора, комментарии команды, поиск по пациенту и просмотр полной истории.

В отличие от уже существующего модуля `portfolio` (маркетинговая «До/После» галерея для мобильного приложения), этот модуль — **внутренний клинический инструмент**, доступный только сотрудникам.

## 2. Решения и ограничения (зафиксировано в брейнсторме)

| # | Решение |
|---|---|
| Объём | 8–15 фото/визит, оценочно 80–200 ГБ/год/салон |
| Срок хранения | 5 лет (горячих ~0.4–1 ТБ за 5 лет) |
| Хранилище | Российский S3 (рекомендация: Яндекс Object Storage), pay-as-you-go |
| Обработка | Оригинал + medium 1200px + thumb 300px, EXIF снимается на загрузке |
| Видимость пациентом | **НЕ** видит в мобильном приложении (staff-only) |
| Доступ внутри салона | Любой сотрудник видит все кейсы; редактировать/удалять — только автор или admin/owner |
| Структура | Альбом-визит (1:1 с YClients record) + опциональная группировка в «курс» |
| Согласие 152-ФЗ | Бумажный пайплайн вне системы; код согласие не проверяет (риск принимает клиника) |
| Стадии фото | Жёсткие 3: `before`, `in_progress`, `after`; подписей на фото нет |
| Поток загрузки | Через бэкенд (`multer.memoryStorage` → `sharp` → S3 PUT) |
| Скоуп MVP | Всё в первом релизе: курсы, комментарии, поиск, всё API |

## 3. Архитектура

### 3.1 Поток загрузки

```
[Staff browser]
    POST /api/patient-portfolio/visits/:id/photos (multipart, stage, до 20 файлов)
       │
       ▼
[Express + multer.memoryStorage (15 МБ/файл, 20 файлов/req)]
       │
       ▼
[services/patient-portfolio.js]
    Для каждого файла последовательно:
      ├─ id = nextval('case_photos_id_seq')
      ├─ sharp(buffer).rotate()                          // выровнять по EXIF Orientation
      ├─ EXIF снимается дефолтом (без .withMetadata())
      ├─ 3 варианта:
      │    original — quality 92, mozjpeg
      │    medium   — fit:'inside' 1200×1200, quality 85
      │    thumb    — fit:'cover'  300×300,  quality 80
      ├─ 3× S3 PutObject (параллельно)
      └─ INSERT case_photos (id, s3_keys, ...)
       │
       ▼
[Response] [{id, urls:{thumb, medium}}, ...]  // pre-signed GET, TTL 15 мин
```

### 3.2 Поток просмотра

```
[Staff browser]
    GET /api/patient-portfolio/clients/:id/cases
       │
       ▼
[backend]
    выгружает кейсы + по 1 photo-thumb на превью карточки,
    генерирует pre-signed GET URL только на thumb (TTL 15 мин)
       │
       ▼
[Browser] показывает таймлайн, на клик → запрос на medium URL, скачать → original URL
```

### 3.3 Ключевые свойства

- Бэкенд **не проксирует байты при отдаче**: браузер качает напрямую с S3 по pre-signed URL.
- Бакет S3 **полностью приватный** (Block Public Access on); файлы доступны только через подписанный URL.
- Все маршруты под общим JWT-auth (`req.user.salon_id`). Роль `specialist` явно добавляется в `SPECIALIST_ALLOWED_PREFIXES` (сейчас не входит).
- Multi-tenant invariant соблюдён: все таблицы скоплены `salon_id` (см. CLAUDE.md).

## 4. Модель данных

Все таблицы добавляются в `backend/migrations.js` блоками `CREATE TABLE IF NOT EXISTS`, идемпотентно.

```sql
-- Опциональный «курс лечения» (несколько визитов под одним лейблом)
CREATE TABLE case_courses (
  id              SERIAL PRIMARY KEY,
  salon_id        INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  client_id       INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title           VARCHAR(200) NOT NULL,
  description     TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_case_courses_client ON case_courses (salon_id, client_id);

-- Кейс-альбом визита (ленивая создание при первой загрузке фото)
CREATE TABLE case_visits (
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
);
CREATE UNIQUE INDEX uq_case_visits_record
  ON case_visits (salon_id, record_id) WHERE record_id IS NOT NULL;
CREATE INDEX idx_case_visits_client_date
  ON case_visits (salon_id, client_id, visit_date DESC);
CREATE INDEX idx_case_visits_course
  ON case_visits (course_id) WHERE course_id IS NOT NULL;

-- Фотографии
CREATE TYPE case_photo_stage AS ENUM ('before','in_progress','after');

CREATE TABLE case_photos (
  id                 BIGSERIAL PRIMARY KEY,
  salon_id           INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  case_visit_id      INTEGER NOT NULL REFERENCES case_visits(id) ON DELETE CASCADE,
  stage              case_photo_stage NOT NULL,
  s3_key_original    TEXT NOT NULL,
  s3_key_medium      TEXT NOT NULL,
  s3_key_thumb       TEXT NOT NULL,
  mime_type          VARCHAR(50) NOT NULL,    -- всегда 'image/jpeg' (re-encoding), но поле оставлено на будущее (WebP/AVIF варианты)
  size_bytes         INTEGER NOT NULL,         -- размер оригинала после re-encode
  width              INTEGER,
  height             INTEGER,
  uploaded_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sort_order         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_case_photos_visit_stage
  ON case_photos (case_visit_id, stage, sort_order);

-- Комментарии к альбому (плоский тред)
CREATE TABLE case_comments (
  id             BIGSERIAL PRIMARY KEY,
  salon_id       INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  case_visit_id  INTEGER NOT NULL REFERENCES case_visits(id) ON DELETE CASCADE,
  author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  text           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_case_comments_visit ON case_comments (case_visit_id, created_at);

-- Очередь зависших S3-объектов (для cron-чистки после неудачных удалений)
CREATE TABLE s3_orphans (
  id          BIGSERIAL PRIMARY KEY,
  bucket      VARCHAR(100) NOT NULL,
  s3_key      TEXT NOT NULL,
  reason      VARCHAR(40),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);
CREATE INDEX idx_s3_orphans_pending ON s3_orphans (created_at) WHERE attempts < 5;
```

**Каскады и удаление файлов:** DB cascade чистит метаданные при удалении клиента/салона; **сами S3-объекты удаляются явно** в коде через `S3.DeleteObjects` batch. Если S3-delete упал — ключ пишется в `s3_orphans`, ночной cron retry до 5 раз.

## 5. API

Все маршруты под `/api/patient-portfolio/*`, защищены общим `auth` middleware. Скоупятся по `req.user.salon_id`.

| Метод | Путь | Кто может | Описание |
|---|---|---|---|
| GET | `/clients/:clientId/cases` | все роли | Список альбомов пациента, keyset pagination `?limit=50&before=<visit_date>` |
| GET | `/clients/:clientId/courses` | все роли | Курсы пациента + вложенные визиты |
| GET | `/visits/:id` | все роли | Полный альбом: метаданные + фото (3 группы по `stage`, thumb+medium URL) + комментарии |
| POST | `/visits` | все роли | `{ client_id, record_id?, course_id?, notes? }`, идемпотентно по `(salon_id, record_id)` |
| PUT | `/visits/:id` | автор/admin/owner | `notes`, `course_id` |
| DELETE | `/visits/:id` | автор/admin/owner | Каскад + S3 cleanup |
| POST | `/visits/:id/photos` | все роли | Multipart: 1..20 файлов + `stage`. Ответ: `[{id, urls:{thumb,medium}}, ...]` |
| PUT | `/photos/:id` | автор/admin/owner | `stage`, `sort_order` |
| DELETE | `/photos/:id` | автор/admin/owner | DB row + S3 cleanup (3 объекта) |
| GET | `/photos/:id/url?variant=original\|medium\|thumb` | все роли | Перевыпустить pre-signed URL (TTL 15 мин) |
| POST | `/courses` | все роли | `{ client_id, title, description? }` |
| PUT | `/courses/:id` | автор/admin/owner | Редактировать |
| DELETE | `/courses/:id` | автор/admin/owner | Курс удалён; визиты остаются, `course_id` → NULL |
| POST | `/visits/:id/comments` | все роли | Добавить комментарий |
| DELETE | `/comments/:id` | автор/admin/owner | Удалить |
| GET | `/search?q=` | все роли | Поиск пациентов с кейсами по имени/телефону |

### 5.1 Правила ролей

Единый хелпер в `services/patient-portfolio.js`:

```js
function assertCanMutate(reqUser, ownerUserId) {
  if (['admin','owner'].includes(reqUser.role)) return;
  if (reqUser.id === ownerUserId) return;
  throw new ForbiddenError('Only the author or admin can modify this');
}
```

«Автор» = `uploaded_by` для фото, `specialist_user_id` для визита-альбома, `created_by` для курса, `author_user_id` для комментария.

**Автозаполнение `specialist_user_id` при ленивом создании альбома:** на первой загрузке фото на визит без существующего альбома — `case_visits.specialist_user_id = req.user.id` (тот, кто загружает первое фото). Если фактический мастер визита в YClients другой — админ/автор может переназначить через `PUT /visits/:id`.

**Если автор-пользователь удалён** (`ON DELETE SET NULL` сделал `specialist_user_id = NULL`): редактировать/удалять может только admin/owner (проверка автора провалится для всех).

### 5.2 Стандартные коды ответов

| Код | Когда |
|---|---|
| 200 | Успех |
| 400 | Невалидный stage / битый файл / mime |
| 401 | Нет JWT |
| 403 | `assertCanMutate` отказал |
| 404 | Сущность не найдена в этом салоне |
| 413 | Файл больше 15 МБ |
| 502 | S3 PUT упал — клиенту «попробуйте ещё раз» (rollback произведён) |

## 6. Файловый пайплайн и S3

### 6.1 Стек

- `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` — работает с любым S3-совместимым (Яндекс/Selectel/Beget), указываем `endpoint`.
- `sharp` — ресайз + EXIF-strip; на Debian/Ubuntu prebuilt libvips ставится автоматически с npm.
- `multer.memoryStorage` — буфер в RAM (как в существующем portfolio).

### 6.2 Обработка фото

```js
const img = sharp(buffer, { failOn: 'truncated' }).rotate();
const meta = await img.metadata();   // width/height для DB

const original = await img.clone()
  .jpeg({ quality: 92, mozjpeg: true }).toBuffer();
const medium = await img.clone()
  .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
  .jpeg({ quality: 85, mozjpeg: true }).toBuffer();
const thumb = await img.clone()
  .resize({ width: 300, height: 300, fit: 'cover' })
  .jpeg({ quality: 80, mozjpeg: true }).toBuffer();
```

EXIF снимается дефолтом — `sharp` не сохраняет метаданные без явного `.withMetadata()`.

### 6.3 Ключи в S3

```
salon_<sid>/client_<cid>/visit_<vid>/<photo_id>_orig.jpg
salon_<sid>/client_<cid>/visit_<vid>/<photo_id>_med.jpg
salon_<sid>/client_<cid>/visit_<vid>/<photo_id>_thumb.jpg
```

`photo_id` — `nextval('case_photos_id_seq')` до загрузки. Дыры в id при сбоях — норма.

### 6.4 Атомарность

1. `id := nextval('case_photos_id_seq')`
2. `Promise.all([put orig, put med, put thumb])` в S3
3. `INSERT case_photos (id, ...)`
4. Если шаг 2 упал хоть на одном — `DeleteObjects` всех уже загруженных, в DB не пишем.
5. Если шаг 3 упал — `DeleteObjects` всех трёх.

### 6.5 Pre-signed URLs

- Дефолтный TTL — **15 минут** (`X-Amz-Expires=900`).
- На list-эндпоинтах — только `thumb` URL.
- На detail-эндпоинте — `thumb` + `medium`.
- `original` — только по явному запросу `GET /photos/:id/url?variant=original`.
- Браузер кеширует подписанные URL — повторных подписей в гриде нет.

### 6.6 Удаление

- Single: `DeleteObject` × 3.
- Cascade (удалили визит): `DeleteObjects` batch по всем ключам визита.
- При ошибке S3 — пишем в `s3_orphans`, cron retry.

### 6.7 Конфиг

```
S3_ENDPOINT=https://storage.yandexcloud.net
S3_REGION=ru-central1
S3_BUCKET=loyalpro-cases-prod
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_FORCE_PATH_STYLE=true
S3_URL_TTL_SECONDS=900
```

### 6.8 HEIC

iPhone-дефолт. `sharp` поддерживает HEIC только с `libheif`. Решение MVP:
- Фронт-фильтр `accept="image/jpeg,image/png,image/webp"` — HEIC в списке не показывается.
- Серверный фоллбэк: `sharp` отвергает → 400 «Используйте JPEG, в Настройках камеры iPhone выберите «Наиболее совместимый»».

Серверная конверсия HEIC — Phase 2, требует пересборки sharp с `libheif`.

## 7. Фронтенд (staff SPA)

Одна новая страница `frontend/js/pages/patient-portfolio.js`, пункт меню «Фото-кейсы» в `nav.js`. Стили — переиспользование классов из существующего портфолио (`stg-section`, `btn-pri`, `fg`/`fl`, модалки).

### 7.1 Три уровня навигации

**Уровень 1 — Поиск пациента.** Поисковая строка (debounced → `/search?q=`). Грид «Недавние пациенты с кейсами» с превью thumb. Фильтр **«Только мои / Все»**: «мои» = пациенты, в чьих альбомах текущий `req.user.id` указан как `specialist_user_id` или `uploaded_by` хотя бы одного фото.

**Уровень 2 — Карточка пациента** (`?clientId=`). Шапка с ФИО, телефоном, ссылкой в YClients. Слева — список курсов и одиночных альбомов. Справа — таймлайн альбомов по датам ↓, карточка показывает дату, специалиста, 3-фото-предпросмотр, бейджи `photos/comments`. Кнопки «+ Курс», «+ Новый альбом».

**Автоподстановка `record_id` при «+ Новый альбом»** (фронт-логика, не серверная): фронт запрашивает у `/api/records` ближайшую незакрытую запись YClients этого пациента за последние 7 дней и предлагает её привязать (с возможностью отказаться → standalone альбом с `record_id = NULL`). Серверный POST `/visits` принимает `record_id` как опциональный.

**Уровень 3 — Альбом-визит** (`?visitId=`). Шапка с метаданными. Три горизонтальные секции «До / В процессе / После» — каждая это фото-грид с drag/drop и кнопкой «+ Добавить фото». Поле «Заметки к визиту» с autosave on blur. Внизу — тред комментариев + форма.

### 7.2 Виджет загрузки

```html
<input type="file" accept="image/jpeg,image/png,image/webp" multiple
       capture="environment">
```

Drag/drop на десктопе. Preview каждого файла до отправки (Canvas → blob → `URL.createObjectURL`). Progress bar на batch. **Серверное API принимает до 20 файлов за запрос**, но фронт чанкает выбор пользователя по 5 файлов в один POST и отправляет последовательно — чтобы не перегрузить sharp/RAM.

### 7.3 Лайтбокс

Модалка с medium-вариантом, ←/→, ESC. Кнопка «Скачать оригинал» → `/photos/:id/url?variant=original` → `window.open`.

## 8. Инфраструктура

### 8.1 Что поднять

1. **S3-бакет** у российского провайдера (Яндекс Object Storage — рекомендация). Block Public Access on, SSE-S3 on, versioning off.
2. **Сервис-аккаунт + ключи**: dev и prod пары, scope доступа — только этот бакет.
3. **npm-зависимости**: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `sharp`.
4. **Миграции** — идемпотентные `CREATE TABLE IF NOT EXISTS` в `backend/migrations.js`, запускаются на старте.
5. **Cron** — одна задача, раз в сутки: `processS3Orphans()`.

### 8.2 Чего НЕ поднимать

Никакого Redis, BullMQ, ClamAV, Lambda, отдельных worker-процессов, нового nginx-конфига. Один Node-процесс.

### 8.3 Бэкапы

- DB бэкапы — общий пайплайн Beget.
- S3 у российских провайдеров — 3-зонная репликация из коробки. Отдельный бэкап опционален.

### 8.4 Текущее железо (217.114.0.254)

Справится без апгрейда. Узкие места:
- **RAM при ресайзе:** `sharp` ~50 МБ на 12 МП фото. Обработка последовательная в рамках batch (`for…of`), параллельно не более 1 batch на 5 файлов.
- **Сеть наружу:** ~150 МБ исходящих в S3 на визит — на 100 Mbps пайпе ~12 с, фон.
- **Диск:** на сервере **ничего не оседает** — всё сразу в S3.

### 8.5 Стоимость (порядок)

| Статья | Старт | Через 5 лет |
|---|---|---|
| S3 storage (Яндекс @1.95 ₽/ГБ) | ~50 ₽ (25 ГБ) | ~2 000 ₽ (1 ТБ) |
| S3 исходящий трафик | ~0 | ~200–500 ₽ |
| **Итого инфра/мес** | **< 100 ₽** | **~2–2.5 k ₽** |

## 9. Обработка ошибок (edge-cases)

| Кейс | Поведение |
|---|---|
| Один из 3 S3 PUT упал | Откат `DeleteObjects` уже загруженных, в DB ничего, 502 клиенту |
| Параллельный `nextval` конфликт | INSERT с конфликтом id → новый `nextval`, перезагрузить с новыми ключами, старые удалить |
| Удалили клиента в нашей DB (каскад) | DB чистая, S3-ключи попадают в `s3_orphans` через before-trigger, cron подбирает |
| Файл >15 МБ | 413 ещё до sharp (multer лимит) |
| Битый/poison mime | `sharp.metadata()` бросает → 400 |
| HEIC | Фронт не показывает; на бэке 400 |
| Сеть моргнула посреди batch | Multer 502, клиент жмёт «Повторить» (идемпотентно, новые id) |
| Pre-signed URL истёк во время просмотра | На 403 `<img>` фронт авто-перезапрашивает `/photos/:id/url` |
| YClients-запись удалили | `case_visits.record_id → NULL`, альбом остаётся, в UI показываем `visit_date` из строки |
| Specialist пытается удалить чужое фото | `assertCanMutate` → 403 |
| `course_id` ссылается на удалённый курс | `ON DELETE SET NULL`, альбом теряет группировку |
| S3 endpoint down | Upload падает 502; просмотр падает (URL не подписать) — крайний случай, ничего не делаем сверх ошибки |

## 10. Тестирование

### 10.1 Unit (чистые функции, как `services/portfolio.js`)

- `buildS3Key(salonId, clientId, visitId, photoId, variant)` — детерминированная сборка.
- `assertCanMutate(user, ownerId)` — матрица 6 кейсов (owner/admin/specialist × свой/чужой).
- `parseStage(input)` — валидация enum, отклонение мусора.
- `pickThumbForCard(photos)` — предпочтение `after` → `in_progress` → `before` → null.
- `normalizePhone(input)` — нормализация для поиска (последние 10 цифр).

### 10.2 Integration (реальная DB + замоканный S3)

`@aws-sdk/client-mock` для S3 (не требует реального бакета).

- POST /visits/:id/photos с 3 файлами → 3 строки в DB, 9 ключей в моке (3 файла × 3 варианта), корректные thumb URL в ответе.
- DELETE /photos/:id → строка ушла, 3 ключа удалены из мока.
- Откат: мок 500 на одном PUT → DB пуста, остатки удалены.
- Поиск: кириллица, телефон с пробелами/`+7`/`8`.
- Роли: specialist пытается удалить чужое → 403; admin удаляет чужое → 200.

### 10.3 Smoke на проде после деплоя

`node backend/patient-cases.smoke.js`:
1. Загрузить тестовое фото в тестовый альбом тест-салона.
2. Проверить, что pre-signed URL отдаёт 200.
3. Удалить.
4. Проверить, что S3 пуст.

## 11. Безопасность

- Все маршруты — JWT-auth + `req.user.salon_id` фильтрация.
- Bucket приватный, SSE-S3 включён.
- Pre-signed URLs короткоживущие (15 мин).
- EXIF снимается на загрузке (нет утечки геолокации/модели устройства).
- Удаление фото — soft в S3 нет; **полное удаление** (не recoverable из бакета без versioning).
- Логи: все DELETE и POST фото пишутся в существующий request-логгер с `user_id` и `client_id` (есть в `req.user`).

## 12. Открытые вопросы и предположения

- Предполагается, что у каждого специалиста уже есть запись в `users` с ролью `specialist` (без неё API будет 401). Если части специалистов нет — отдельная задача создать аккаунты.
- Предполагается, что таблица `records` уже имеет связь с пациентом (`records.client_id`), используется в `case_visits.record_id` через FK.
- Размер RAM прод-сервера на момент написания спеки **не подтверждён** — план должен включить шаг «проверить free memory под `sharp` нагрузкой, при <4 ГБ — ограничить concurrency до 1».
- Бэкап-стратегия отдельного бакета (cross-provider sync) — НЕ в скоупе MVP, можно вернуться позже.
