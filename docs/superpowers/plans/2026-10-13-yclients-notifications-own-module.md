# Свой модуль уведомлений YClients вместо Chatpush — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Служебные уведомления клиентам по событиям записи YClients (создание, перенос, отмена, напоминание за N часов, опрос после визита, рекомендации по услуге с фото, приглашение в лояльность при первом визите) и обработка ответов на них («Подтверждаю» → статус «Подтвердил» в YClients, «5» → оценка и благодарность) генерирует и шлёт LoyalPro сам, через `services/messaging/transport.js`, с теневым режимом для сверки с Chatpush до переключения.

**Architecture:** v1-модуль `services/notifications.js` (правила + условия + каскад каналов + воркер) разбирается на папку `services/notifications/` и расширяется: `trigger_type` получает семь значений, очередь переезжает в `notification_jobs` со `scheduled_at` (старая `notification_sends` остаётся историей), детерминированное различение событий записи ведёт собственная таблица `notification_record_state`, ответы пациентов перехватываются в `routes/chatpush-webhook.js` ДО постановки Милы в очередь. Настройки салона (режим off/shadow/live, тексты отбивок по полосам оценки, тихие часы) — `notification_settings`. Каналы — только мессенджеры через свой шлюз (Telegram, WhatsApp, MAX); SMS нет.

**Решения владельца (14.10.2026), план их уже учитывает:** MAX идёт через СВОЙ шлюз (на проде с 14.10), отдельного решения не нужно; SMS-фолбэка нет; оценка — три полосы: 5 → благодарность со ссылками, 4 → «что улучшить» без перевода, 2–3 → «что не устроило» + перевод на администратора; «Вы записаны» уходит и по записям, созданным Милой (флага исключения нет); тихие часы включены по умолчанию 21:00–09:00 и сдвигают только ОТЛОЖЕННЫЕ уведомления (напоминание, опрос, рекомендации) — мгновенные «создана/перенесена/отменена» уходят сразу, иначе ночная запись Милы осталась бы без подтверждения до утра.

**Tech Stack:** Node 20, Express, PostgreSQL (`pg`, без ORM), Jest (`npx jest <имя>` в `backend/`, TZ=Europe/Moscow через global-setup), multer, существующие `transport`/`messenger_accounts`/шлюз.

Спека: `docs/superpowers/specs/2026-10-13-yclients-notifications-own-module-design.md`.

---

## Контекст для исполнителя (прочитать целиком до первой задачи)

**Откуда приходят события.** YClients шлёт вебхук на `routes/webhook.js` (`/yclients/webhook.v2/:companyId`). Для `resource === 'record'` тело: `{ status: 'create'|'update'|'delete', data: { id, date:'2026-10-14 13:30:00', datetime:'2026-10-14T13:30:00+03:00', seance_length: 3600, length, attendance: 0|1|2|-1, deleted: bool, sms_before: 24, sms_remain_hours, client:{id, phone, name}, staff:{id, name}, staff_id, services:[{id,title,cost}], created_user_id, short_link, comment, visit_id } }`. Маршрут отвечает 200 СРАЗУ, затем зовёт `processRecordEvent` (кэшбэк), потом — хуки «Заботы», напоминаний и наш `handleRecordCreated` (строка `backend/routes/webhook.js:82`). Каждый хук в своём `try/catch`.

**Смыслы `attendance`:** `2` подтвердил, `1` пришёл, `0` ожидание, `-1` не пришёл. Отмена в YClients приходит как `status:'delete'` ИЛИ `update` с `deleted:true` ИЛИ `update` с `attendance:-1` (администратор поставил «не пришёл»). Предоплаченная неявка несёт `paid_full=1` вместе с `attendance=-1`.

**Куда уходят сообщения.** `transport.sendMessage(salonId, { text, phone, dispatchRouting:['tdlib','whatsapp','max'], tdlib_user_id?, max_user_id? })` → `{ id, channel|channels, accountId, status }`; `transport.sendFile(salonId, { fileName, caption, type:'image'|'document', phone, dispatchRouting }, buffer, mimeType)`. Каналы без аккаунта в `messenger_accounts` пропускаются; к следующему аккаунту транспорт переходит только при однозначном отказе (4xx), таймаут/5xx — бросок (сообщение могло уйти). Исходящие ОБЯЗАНЫ попасть в транскрипт Милы: `pendingReplies.remember(salonId, phone, text)`, `authorship.remember(salonId, phone, text, 'system')` (иначе эхо выглядит ответом живого администратора и ставит Милу на паузу — инцидент 04.08), для WhatsApp — `chatPersist.persistWhatsappOutgoing(...)` (WhatsApp эхо не шлёт). Всё это уже делает v1-воркер, код переносится как есть.

**Ответы пациентов** приходят в `routes/chatpush-webhook.js` (и `/gateway/webhook` — тот же роутер). После сохранения входящего (`storedNew`) и SSE, перед блоком `dispatcher.enqueue` (строка ~322) — место для нашего перехвата. `msg` имеет `{direction, channel, phone, chatId, chatType, type, text, messageId}`; ключ диалога — `(msg.phone && msg.phone.trim()) || msg.chatId`. Детекторы готовы: `services/agent/visit-confirmation.js` → `isPureConfirmation(text)`, `isReminder(text)`; `services/agent/visit-rating.js` → `parseRating(text)` (число 2–5 или null), `isRatingSurvey(text)`. Последнее исходящее диалога — `services/agent/history.lastOutgoing(salonId, dialogKey)` → `{author, text}|null`. Адресация ответа — `services/chat.recipientParams(channel, {phone, chat_id})` → `{dispatchRouting, phone?, tdlib_user_id?, max_user_id?}` | null.

**Статус «Подтвердил» в YClients** — `services/yclients-records.updateAttendance(salon, ycRecordId, 2)` (PUT `/record/{cid}/{id}` только с `attendance`; бросает при отказе). `salon` — строка `salons` (`id, name, yclients_company_id, yclients_user_token …`), грузится `db.oneOrNone('SELECT * FROM salons WHERE id=$1')`.

**Правила проекта (CLAUDE.md), нарушать нельзя:** миграции только `IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS`, ничего деструктивного; каждый запрос со `salon_id`; `db.one` НЕ бросает на пустой выборке (возвращает `null`); Jest-тесты лежат в `backend/*.test.js` и мокают `./db` через `jest.mock`; бамп `?v=` при правке JS фронта (`frontend/index.html`); рестарт дева `PORT=3001 pm2 restart loyalpro`; SQL-проверки через MCP `mcp__postgres__query`; коммит — на задачу, сообщение по-русски, последняя строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. После правок SQL аренды (`FOR UPDATE SKIP LOCKED`, скалярные подзапросы) — живой EXPLAIN на дев-БД, юнит-моки валидность SQL не проверяют.

**Контракт модуля (задачи ссылаются на него):**

```
trigger_type: record_created | record_rescheduled | record_cancelled | visit_reminder | visit_review | visit_after | first_visit
notification_settings.mode: off | shadow | live
notification_jobs.status: pending | sent | shadow | skipped | cancelled | failed
snapshot (events.recordSnapshot): { recordId, status, visitAt(ms|null), seanceLength(s), attendance, deleted, smsBefore,
  staffId, staffName, services:[{id,title}], clientYcId, phone(канон 7…), clientName, createdUserId, shortLink }
kinds (events.classifyRecordEvent): { created, rescheduled, cancelled, noShow, arrived, confirmed }
```

---

## Структура файлов

**Создать:**
- `backend/scripts/chatpush-notifications-harvest.js` — выгрузка текстов шаблонов и картинок «Рекомендации» из `chatpush_messages` (подписанные URL живут 7 дней — задача №1 по сроку).
- `backend/services/notifications/events.js` — чистое: снимок записи, классификация события, расчёт моментов отправки, тихие часы.
- `backend/services/notifications/render.js` — плейсхолдеры шаблона (переезд `renderTemplate` + новые).
- `backend/services/notifications/rules.js` — `evaluateRule`, `resolveRouting`, карта услуга→категория, `lastIncomingChannel` (переезд из v1 без изменений).
- `backend/services/notifications/enroll.js` — `handleRecordEvent`: состояние записи, постановка/гашение job'ов.
- `backend/services/notifications/worker.js` — аренда, перепроверка, тень/боевой режим, отправка, журнал.
- `backend/services/notifications/replies.js` — перехват «Подтверждаю»/оценки.
- `backend/services/notifications/settings.js` — чтение/запись `notification_settings` с дефолтами.
- `backend/notifications-events.test.js`, `notifications-render.test.js`, `notifications-enroll.test.js`, `notifications-worker.test.js`, `notifications-replies.test.js`, `notifications-routes.test.js`.
- `backend/scripts/notifications-parity.js`, `backend/scripts/notifications-e2e.js`, `backend/scripts/notifications-replies-e2e.js`.
- `frontend/js/pages/notifications.js` — новая вкладка (заменяет `broadcast-rules.js`, тот остаётся на диске, но из `index.html` снимается).
- `docs/notifications/chatpush-templates-2026-10-13.md` — выгруженные тексты (результат задачи 1).
- `docs/2026-10-13-notifications-cutover-runbook.md` — порядок переключения.

**Изменить:**
- `backend/migrations.js` — новые таблицы/колонки (после блока `notification_sends`, строка ~906).
- `backend/services/notifications.js` — становится фасадом: ре-экспорт из папки, `handleRecordEvent`, `startNotificationWorker`.
- `backend/routes/webhook.js:5,82-84` — `handleRecordEvent` на любом `record`-событии.
- `backend/routes/chatpush-webhook.js:~322` — перехват ответов.
- `backend/routes/notification-rules.js` — новые поля правил, `/settings`, `/jobs`, `/:id/attachment`, `/:id/test`, `/ratings`, `/parity`.
- `backend/services/messaging/transport.js:132` — экспорт `isDefiniteRejection` (решает, можно ли повторить отправку).
- `backend/services/messaging/send-pacing.js:50` — учесть `notification_jobs`.
- `frontend/index.html:1110-1125, 2559` — разметка вкладки, подключение `notifications.js`.
- `CLAUDE.md` — раздел «Уведомления YClients».

---

### Task 1: Выгрузить тексты и картинки Chatpush (срочно — подписанные URL картинок живут 7 дней)

**Files:**
- Create: `backend/scripts/chatpush-notifications-harvest.js`
- Create (результат): `docs/notifications/chatpush-templates-2026-10-13.md`, `frontend/uploads/notify_seed/*.jpg`, `frontend/uploads/notify_seed/manifest.json`

- [ ] **Step 1: Написать скрипт**

```js
'use strict';
// Выгрузка того, что Chatpush/YClients реально шлют пациентам: уникальные тексты
// служебных исходящих (authored_by='system') и картинки «Рекомендации после
// процедуры» по их подписанным URL (Яндекс S3, срок жизни 7 дней — поэтому
// скрипт запускается ПЕРВЫМ). Ничего не пишет в БД, ничего не отправляет.
// Запуск: cd backend && node scripts/chatpush-notifications-harvest.js [--salon=1] [--days=45]
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { db, pool } = require('../db');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const salonId = Number(args.salon || 1);
const days = Number(args.days || 45);
const outDir = path.join(__dirname, '../../frontend/uploads/notify_seed');
const docPath = path.join(__dirname, '../../docs/notifications/chatpush-templates-2026-10-13.md');

function slug(s) { return String(s).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80); }

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.dirname(docPath), { recursive: true });

  const templates = await db.any(
    `SELECT regexp_replace(text, '\\d+', '#', 'g') AS tpl, min(text) AS sample,
            count(*) AS n, array_agg(DISTINCT channel) AS channels,
            to_char(to_timestamp(max(msg_ts)) AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS last_at
       FROM chatpush_messages
      WHERE salon_id = $1 AND direction = 'outgoing' AND authored_by = 'system'
        AND msg_ts > extract(epoch from now() - make_interval(days => $2))
      GROUP BY 1 HAVING count(*) >= 3 ORDER BY n DESC`,
    [salonId, days]);

  const photos = await db.any(
    `SELECT DISTINCT ON (fname) fname, file_url, mime_type, n FROM (
       SELECT substring(file_url from 'delivery_files_new/[^/]+/[^/]+/[^/]+/[^/]+/([^?]+)') AS fname,
              file_url, mime_type, count(*) OVER (PARTITION BY substring(file_url from 'delivery_files_new/[^/]+/[^/]+/[^/]+/[^/]+/([^?]+)')) AS n,
              msg_ts
         FROM chatpush_messages
        WHERE salon_id = $1 AND direction = 'outgoing' AND authored_by = 'system'
          AND file_url IS NOT NULL AND text LIKE 'Рекомендации после%'
          AND msg_ts > extract(epoch from now() - interval '6 days')) t
     WHERE fname NOT LIKE '%\\_media.jpg' ORDER BY fname, msg_ts DESC`,
    [salonId]);

  const manifest = [];
  for (const p of photos) {
    const name = slug(decodeURIComponent(p.fname));
    const dest = path.join(outDir, name);
    try {
      const { data } = await axios.get(p.file_url, { responseType: 'arraybuffer', timeout: 60000 });
      fs.writeFileSync(dest, Buffer.from(data));
      manifest.push({ file: name, mime: p.mime_type, sends: Number(p.n) });
      console.log(`saved ${name} (${data.byteLength} b, ${p.n} отправок)`);
    } catch (e) { console.warn(`FAIL ${name}: ${e.message}`); }
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const lines = [`# Шаблоны Chatpush/YClients для салона ${salonId} (последние ${days} дней)`, '',
    'Выгружено скриптом `backend/scripts/chatpush-notifications-harvest.js`. Числа в шаблоне заменены на `#`.', ''];
  for (const t of templates) {
    lines.push(`## ${t.n} отправок · каналы ${t.channels.join(', ')} · последняя ${t.last_at}`, '', '```', t.sample, '```', '');
  }
  lines.push('## Картинки «Рекомендации после процедуры»', '', ...manifest.map((m) => `- ${m.file} — ${m.sends} отправок`));
  fs.writeFileSync(docPath, lines.join('\n'));
  console.log(`templates: ${templates.length}, photos: ${manifest.length} → ${docPath}`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Запустить на деве**

Run: `cd /root/loyalpro/backend && node scripts/chatpush-notifications-harvest.js --salon=1 --days=45`
Expected: строки `saved Ботулинотерапия.jpg …` (ожидается 9 файлов: Ботулинотерапия, Био-Мезо-Коллаген-Плазма, Фотоомоложение, Комбинированная чистка лица, Пилинг, Липолитики, Morpheus 8, Полимолочная кислота, Volnewmer) и `templates: ~12, photos: 9`. Если какой-то URL уже протух (403) — WARN, скрипт идёт дальше; недостающую картинку запросить у владельца.

- [ ] **Step 3: Проверить, что картинки открываются**

Run: `file /root/loyalpro/frontend/uploads/notify_seed/*.jpg | head`
Expected: `JPEG image data` у каждого файла.

- [ ] **Step 4: Commit** (картинки — в репозиторий НЕ коммитить, `frontend/uploads/` в `.gitignore`; коммитим скрипт и md)

```bash
cd /root/loyalpro && git add backend/scripts/chatpush-notifications-harvest.js docs/notifications/chatpush-templates-2026-10-13.md
git commit -m "chore(notifications): выгрузка текстов и картинок уведомлений Chatpush для переноса

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Миграции — таблицы и колонки модуля

**Files:**
- Modify: `backend/migrations.js` (вставить после блока `idx_notification_sends_sent`, строка ~906)
- Modify: `backend/services/messaging/send-pacing.js:44-56`

- [ ] **Step 1: Добавить миграции**

Вставить после `idx_notification_sends_sent`:

```js
  // ── Уведомления YClients своими силами (замена Chatpush, 2026-10-13) ──
  // Спека docs/superpowers/specs/2026-10-13-yclients-notifications-own-module-design.md.
  // notification_rules получает новые trigger_type и поля; очередь — notification_jobs
  // (notification_sends остаётся историей v1, воркер её больше не читает).
  for (const col of [
    'hours_before INTEGER',
    'delay_minutes INTEGER',
    'attachment_url TEXT',
    'attachment_name VARCHAR(255)',
    'on_no_show BOOLEAN NOT NULL DEFAULT TRUE',
    'ask_confirmation BOOLEAN NOT NULL DEFAULT TRUE',
  ]) {
    await client.query(`ALTER TABLE notification_rules ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS notification_settings (
      salon_id             INTEGER PRIMARY KEY REFERENCES salons(id) ON DELETE CASCADE,
      mode                 VARCHAR(10) NOT NULL DEFAULT 'off',
      default_channels     JSONB NOT NULL DEFAULT '["tdlib","whatsapp","max"]'::jsonb,
      quiet_from           VARCHAR(5) DEFAULT '21:00',
      quiet_to             VARCHAR(5) DEFAULT '09:00',
      confirm_reply_text   TEXT NOT NULL DEFAULT '✅ Ваша запись подтверждена.\nБудем ждать вас!',
      rating_high_text     TEXT NOT NULL DEFAULT 'Спасибо за отличную оценку нашей работы! 🙏🏻',
      rating_mid_text      TEXT NOT NULL DEFAULT 'Спасибо за оценку! Подскажите, пожалуйста, что нам стоит улучшить? Мы обязательно учтём.',
      rating_low_text      TEXT NOT NULL DEFAULT 'Благодарим Вас за оценку.\nНе могли бы Вы рассказать, что именно Вас не устроило? Мы постараемся принять меры и, по возможности, исправить данную ситуацию.',
      rating_escalate_low  BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS notification_jobs (
      id                  BIGSERIAL PRIMARY KEY,
      salon_id            INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      rule_id             INTEGER REFERENCES notification_rules(id) ON DELETE SET NULL,
      rule_title          VARCHAR(255),
      trigger_type        VARCHAR(40) NOT NULL,
      yclients_record_id  BIGINT NOT NULL DEFAULT 0,
      visit_datetime      TIMESTAMPTZ,
      client_id           INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      phone               VARCHAR(32),
      scheduled_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status              VARCHAR(20) NOT NULL DEFAULT 'pending',
      attempts            INTEGER NOT NULL DEFAULT 0,
      error               TEXT,
      rendered_text       TEXT NOT NULL,
      attachment_url      TEXT,
      routing             JSONB,
      channel_used        VARCHAR(30),
      delivery_id         VARCHAR(120),
      meta                JSONB NOT NULL DEFAULT '{}'::jsonb,
      confirmed_at        TIMESTAMPTZ,
      decision_reason     TEXT,
      last_attempt_at     TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at             TIMESTAMPTZ
    )
  `).catch(() => {});
  // Один job на (правило, запись, момент визита): перенос даёт новый ключ,
  // повтор вебхука — DO NOTHING. visit_datetime NULL у тестовых отправок —
  // уникальность по NULL не работает, поэтому COALESCE на эпоху.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_jobs_rule_record_visit
      ON notification_jobs (rule_id, yclients_record_id, COALESCE(visit_datetime, 'epoch'::timestamptz))
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_notification_jobs_due
      ON notification_jobs (scheduled_at, id) WHERE status = 'pending'
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_notification_jobs_record
      ON notification_jobs (salon_id, yclients_record_id)
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_notification_jobs_phone_sent
      ON notification_jobs (salon_id, phone, sent_at DESC) WHERE status = 'sent'
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_notification_jobs_sent
      ON notification_jobs (salon_id, sent_at DESC) WHERE status = 'sent'
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_notification_jobs_journal
      ON notification_jobs (salon_id, created_at DESC)
  `).catch(() => {});

  // Последнее известное состояние записи — чтобы отличать перенос (datetime
  // изменился) от прочих update: records к моменту хука уже перезаписан
  // processRecordEvent, прежнего значения там нет.
  await client.query(`
    CREATE TABLE IF NOT EXISTS notification_record_state (
      salon_id            INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      yclients_record_id  BIGINT NOT NULL,
      visit_datetime      TIMESTAMPTZ,
      seance_length       INTEGER,
      attendance          INTEGER NOT NULL DEFAULT 0,
      deleted             BOOLEAN NOT NULL DEFAULT FALSE,
      services            JSONB NOT NULL DEFAULT '[]'::jsonb,
      staff_id            BIGINT,
      client_yc_id        BIGINT,
      phone               VARCHAR(32),
      created_user_id     BIGINT,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (salon_id, yclients_record_id)
    )
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS visit_ratings (
      id                  BIGSERIAL PRIMARY KEY,
      salon_id            INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      yclients_record_id  BIGINT NOT NULL,
      client_id           INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      phone               VARCHAR(32),
      rating              SMALLINT NOT NULL,
      comment             TEXT,
      source_job_id       BIGINT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (salon_id, yclients_record_id)
    )
  `).catch(() => {});
```

- [ ] **Step 2: Учесть новую очередь в темпе отправки**

В `send-pacing.js` запрос `lastPlannedSendAt` считает `greatest()` трёх `max()`. Добавить четвёртый подзапрос рядом с `notification_sends`:

```sql
      (SELECT max(j.sent_at) FROM notification_jobs j
        WHERE j.salon_id = $1 AND j.status = 'sent'),
```

и в `greatest(...)` — четвёртый аргумент. Комментарий в шапке файла дополнить: «автоуведомления v2 — `notification_jobs`».

- [ ] **Step 3: Прогнать миграции на деве и проверить таблицы**

Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 5 && pm2 logs loyalpro --lines 20 --nostream | grep -i -E "migrat|error" | tail -5`
Затем MCP `mcp__postgres__query`: `SELECT table_name FROM information_schema.tables WHERE table_name IN ('notification_settings','notification_jobs','notification_record_state','visit_ratings')` → 4 строки; `SELECT column_name FROM information_schema.columns WHERE table_name='notification_rules' AND column_name IN ('hours_before','ask_confirmation')` → 2 строки.

- [ ] **Step 4: Тесты темпа**

Run: `cd /root/loyalpro/backend && npx jest messaging-send-pacing`
Expected: PASS (если тест сверяет текст SQL — поправить ожидание на четыре подзапроса).

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/migrations.js backend/services/messaging/send-pacing.js backend/messaging-send-pacing.test.js
git commit -m "feat(notifications): таблицы notification_settings/jobs/record_state, visit_ratings; новые поля правил

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Чистый модуль событий `events.js` (снимок записи, классификация, моменты отправки)

**Files:**
- Create: `backend/services/notifications/events.js`
- Test: `backend/notifications-events.test.js`

- [ ] **Step 1: Написать падающие тесты**

```js
'use strict';
const ev = require('./services/notifications/events');

const base = {
  status: 'create',
  data: {
    id: 100, datetime: '2026-10-20T13:30:00+03:00', date: '2026-10-20 13:30:00', seance_length: 3600,
    attendance: 0, deleted: false, sms_before: 24, client: { id: 7, phone: '+7 (920) 025-55-91', name: 'Иванова Анна' },
    staff: { id: 55, name: 'Татьяна' }, services: [{ id: 1, title: 'Пилинг' }], created_user_id: 13287477,
    short_link: 'https://yc.gl/c/x/y',
  },
};
const T = (iso) => new Date(iso).getTime();

describe('recordSnapshot', () => {
  test('нормализует телефон, момент визита и поля', () => {
    const s = ev.recordSnapshot(base);
    expect(s.recordId).toBe(100);
    expect(s.phone).toBe('79200255591');
    expect(s.visitAt).toBe(T('2026-10-20T13:30:00+03:00'));
    expect(s.seanceLength).toBe(3600);
    expect(s.smsBefore).toBe(24);
    expect(s.staffId).toBe(55);
    expect(s.services).toEqual([{ id: 1, title: 'Пилинг' }]);
    expect(s.createdUserId).toBe(13287477);
  });
  test('status=delete → deleted', () => {
    expect(ev.recordSnapshot({ ...base, status: 'delete' }).deleted).toBe(true);
  });
  test('без datetime берёт date как московское время', () => {
    const s = ev.recordSnapshot({ ...base, data: { ...base.data, datetime: undefined } });
    expect(s.visitAt).toBe(T('2026-10-20T13:30:00+03:00'));
  });
});

describe('classifyRecordEvent', () => {
  const snap = ev.recordSnapshot(base);
  test('первое появление с create → created', () => {
    expect(ev.classifyRecordEvent(null, snap)).toMatchObject({ created: true, rescheduled: false, cancelled: false, arrived: false });
  });
  test('первое появление с update → не created (только состояние)', () => {
    const upd = ev.recordSnapshot({ ...base, status: 'update' });
    expect(ev.classifyRecordEvent(null, upd).created).toBe(false);
  });
  test('смена datetime → rescheduled', () => {
    const moved = ev.recordSnapshot({ ...base, status: 'update', data: { ...base.data, datetime: '2026-10-21T10:00:00+03:00' } });
    expect(ev.classifyRecordEvent(snap, moved)).toMatchObject({ rescheduled: true, created: false });
  });
  test('deleted → cancelled один раз', () => {
    const del = ev.recordSnapshot({ ...base, status: 'update', data: { ...base.data, deleted: true } });
    expect(ev.classifyRecordEvent(snap, del)).toMatchObject({ cancelled: true, noShow: false });
    expect(ev.classifyRecordEvent(del, del).cancelled).toBe(false);
  });
  test('attendance=-1 → cancelled + noShow', () => {
    const ns = ev.recordSnapshot({ ...base, status: 'update', data: { ...base.data, attendance: -1 } });
    expect(ev.classifyRecordEvent(snap, ns)).toMatchObject({ cancelled: true, noShow: true });
  });
  test('attendance 0→1 → arrived, 1→1 нет', () => {
    const arr = ev.recordSnapshot({ ...base, status: 'update', data: { ...base.data, attendance: 1 } });
    expect(ev.classifyRecordEvent(snap, arr).arrived).toBe(true);
    expect(ev.classifyRecordEvent(arr, arr).arrived).toBe(false);
  });
  test('attendance=2 → confirmed', () => {
    const c = ev.recordSnapshot({ ...base, status: 'update', data: { ...base.data, attendance: 2 } });
    expect(ev.classifyRecordEvent(snap, c).confirmed).toBe(true);
  });
});

describe('reminderAt', () => {
  const snap = ev.recordSnapshot(base);           // визит 20.10 13:30 мск
  test('за hours_before правила', () => {
    expect(ev.reminderAt(snap, { hours_before: 24 }, {}, T('2026-10-18T10:00:00+03:00')))
      .toBe(T('2026-10-19T13:30:00+03:00'));
  });
  test('sms_before записи перекрывает правило', () => {
    const s = { ...snap, smsBefore: 2 };
    expect(ev.reminderAt(s, { hours_before: 24 }, {}, T('2026-10-18T10:00:00+03:00')))
      .toBe(T('2026-10-20T11:30:00+03:00'));
  });
  test('момент уже прошёл → null (YClients тоже не шлёт)', () => {
    expect(ev.reminderAt(snap, { hours_before: 24 }, {}, T('2026-10-19T14:00:00+03:00'))).toBeNull();
  });
  test('тихие часы сдвигают на quiet_to', () => {
    const night = { ...snap, visitAt: T('2026-10-20T23:00:00+03:00') };  // напоминание в 23:00 19.10
    expect(ev.reminderAt(night, { hours_before: 24 }, { quiet_from: '22:00', quiet_to: '09:00' }, T('2026-10-18T10:00:00+03:00')))
      .toBe(T('2026-10-20T09:00:00+03:00'));
  });
  test('сдвиг тихими часами за момент визита → null', () => {
    const early = { ...snap, visitAt: T('2026-10-20T08:00:00+03:00'), smsBefore: 2 };
    expect(ev.reminderAt(early, { hours_before: 24 }, { quiet_from: '22:00', quiet_to: '09:00' }, T('2026-10-18T10:00:00+03:00'))).toBeNull();
  });
});

describe('afterVisitAt', () => {
  const snap = ev.recordSnapshot(base);
  test('конец визита + delay', () => {
    expect(ev.afterVisitAt(snap, 5, T('2026-10-20T13:40:00+03:00'))).toBe(T('2026-10-20T14:35:00+03:00'));
  });
  test('«пришёл» поставлен после окончания → от now', () => {
    expect(ev.afterVisitAt(snap, 5, T('2026-10-20T15:00:00+03:00'))).toBe(T('2026-10-20T15:05:00+03:00'));
  });
});

describe('applyQuietHours', () => {
  test('вне окна — без изменений', () => {
    const t = T('2026-10-20T12:00:00+03:00');
    expect(ev.applyQuietHours(t, { quiet_from: '22:00', quiet_to: '09:00' })).toBe(t);
  });
  test('ночью → ближайшее quiet_to', () => {
    expect(ev.applyQuietHours(T('2026-10-20T01:30:00+03:00'), { quiet_from: '22:00', quiet_to: '09:00' }))
      .toBe(T('2026-10-20T09:00:00+03:00'));
    expect(ev.applyQuietHours(T('2026-10-20T22:30:00+03:00'), { quiet_from: '22:00', quiet_to: '09:00' }))
      .toBe(T('2026-10-21T09:00:00+03:00'));
  });
  test('битые границы → без изменений', () => {
    const t = T('2026-10-20T01:30:00+03:00');
    expect(ev.applyQuietHours(t, { quiet_from: '25:00', quiet_to: '09:00' })).toBe(t);
    expect(ev.applyQuietHours(t, {})).toBe(t);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd /root/loyalpro/backend && npx jest notifications-events`
Expected: FAIL — `Cannot find module './services/notifications/events'`.

- [ ] **Step 3: Реализация**

```js
'use strict';
// ============================================================
// Уведомления YClients — чистая часть: снимок записи из вебхука, классификация
// события относительно прошлого состояния, моменты отправки. Без БД и сети.
// Всё время — unix-миллисекунды; Москва фиксируется смещением +03:00 (перевода
// часов нет), как в services/care/schedule.js.
// ============================================================
const { normalizePhoneKey } = require('../agent-gate');

const MSK_OFFSET_MS = 3 * 3600 * 1000;

/** '2026-10-20T13:30:00+03:00' | '2026-10-20 13:30:00' → ms | null */
function parseVisitAt(datetime, date) {
  const iso = String(datetime || '').trim();
  if (iso) { const t = Date.parse(iso); if (!Number.isNaN(t)) return t; }
  const m = String(date || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:00+03:00`);
  return Number.isNaN(t) ? null : t;
}

function recordSnapshot(payload) {
  const d = (payload && payload.data) || {};
  const status = String((payload && payload.status) || '');
  const services = (Array.isArray(d.services) ? d.services : [])
    .filter((s) => s && s.id != null).map((s) => ({ id: Number(s.id), title: s.title || '' }));
  return {
    recordId: Number(d.id),
    status,
    visitAt: parseVisitAt(d.datetime, d.date),
    seanceLength: Number(d.seance_length || d.length || 0) || 0,
    attendance: Number(d.attendance == null ? 0 : d.attendance) || 0,
    deleted: d.deleted === true || status === 'delete',
    smsBefore: Number(d.sms_before || 0) || 0,
    staffId: d.staff && d.staff.id != null ? Number(d.staff.id) : (d.staff_id != null ? Number(d.staff_id) : null),
    staffName: (d.staff && d.staff.name) || '',
    services,
    clientYcId: d.client && d.client.id != null ? Number(d.client.id) : null,
    phone: normalizePhoneKey(d.client && d.client.phone) || null,
    clientName: (d.client && d.client.name) || '',
    createdUserId: d.created_user_id != null ? Number(d.created_user_id) : null,
    shortLink: d.short_link || '',
  };
}

/**
 * prev — прошлое состояние (строка notification_record_state, приведённая к
 * полям снимка: visitAt, attendance, deleted) или null.
 */
function classifyRecordEvent(prev, snap) {
  const wasCancelled = !!(prev && (prev.deleted || Number(prev.attendance) === -1));
  const isCancelledNow = snap.deleted || snap.attendance === -1;
  const cancelled = isCancelledNow && !wasCancelled;
  const created = !prev && snap.status === 'create' && !isCancelledNow;
  const rescheduled = !!prev && !isCancelledNow && !wasCancelled
    && prev.visitAt != null && snap.visitAt != null && prev.visitAt !== snap.visitAt;
  const arrived = !snap.deleted && snap.attendance === 1 && !(prev && Number(prev.attendance) === 1);
  const confirmed = !snap.deleted && snap.attendance === 2 && !(prev && Number(prev.attendance) === 2);
  return { created, rescheduled, cancelled, noShow: cancelled && !snap.deleted && snap.attendance === -1, arrived, confirmed };
}

function parseHm(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Момент внутри тихих часов → ближайшее quiet_to (мск); иначе как есть. */
function applyQuietHours(ms, settings) {
  const from = parseHm(settings && settings.quiet_from);
  const to = parseHm(settings && settings.quiet_to);
  if (from == null || to == null || from === to) return ms;
  const local = ms + MSK_OFFSET_MS;
  const minuteOfDay = Math.floor((local % 86400000) / 60000);
  const inWindow = from < to ? (minuteOfDay >= from && minuteOfDay < to)
    : (minuteOfDay >= from || minuteOfDay < to);
  if (!inWindow) return ms;
  const dayStart = local - (local % 86400000);
  let target = dayStart + to * 60000;
  if (target <= local) target += 86400000;
  return target - MSK_OFFSET_MS;
}

/** Напоминание: visitAt − часы; sms_before записи главнее правила. Прошло → null. */
function reminderAt(snap, rule, settings, nowMs) {
  if (snap.visitAt == null) return null;
  const hours = snap.smsBefore > 0 ? snap.smsBefore : Number((rule && rule.hours_before) || 24);
  let at = snap.visitAt - hours * 3600 * 1000;
  if (at <= nowMs) return null;
  at = applyQuietHours(at, settings);
  if (at >= snap.visitAt) return null;
  return at;
}

/** Конец визита (или now, если «пришёл» поставлен позже) + delay минут. */
function afterVisitAt(snap, delayMinutes, nowMs) {
  const end = snap.visitAt != null ? snap.visitAt + snap.seanceLength * 1000 : nowMs;
  return Math.max(end, nowMs) + Number(delayMinutes || 0) * 60 * 1000;
}

module.exports = { parseVisitAt, recordSnapshot, classifyRecordEvent, applyQuietHours, reminderAt, afterVisitAt, MSK_OFFSET_MS };
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd /root/loyalpro/backend && npx jest notifications-events`
Expected: PASS, 17 тестов.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/notifications/events.js backend/notifications-events.test.js
git commit -m "feat(notifications): чистый модуль событий записи — снимок, классификация, моменты отправки

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `render.js` и `rules.js` — переезд чистых помощников v1 + новые плейсхолдеры

**Files:**
- Create: `backend/services/notifications/render.js`, `backend/services/notifications/rules.js`
- Modify: `backend/services/notifications.js` (фасад — пока только ре-экспорт; воркер v1 остаётся до Task 6)
- Test: `backend/notifications-render.test.js`; существующий `backend/notifications.test.js` должен остаться зелёным

- [ ] **Step 1: Падающий тест рендера**

```js
'use strict';
const { renderTemplate, buildRenderCtx } = require('./services/notifications/render');

describe('renderTemplate', () => {
  const ctx = { name: 'Иванова Анна Петровна', date: '20.10.2026', time: '13:30', end_time: '14:30',
    services: 'Пилинг', staff: 'Татьяна', salon: 'PERI CLINIC', record_link: 'https://yc.gl/c/x', rating_links: 'Яндекс https://ya.cc/1' };
  test('все плейсхолдеры', () => {
    expect(renderTemplate('{first_name}, {date} {time}–{end_time}, {services}, {staff}, {salon}, {record_link}, {rating_links}, {name}', ctx))
      .toBe('Анна, 20.10.2026 13:30–14:30, Пилинг, Татьяна, PERI CLINIC, https://yc.cl/c/x'.replace('yc.cl', 'yc.gl') + ', Яндекс https://ya.cc/1, Иванова Анна Петровна');
  });
  test('нет имени → осиротевшая запятая убирается', () => {
    expect(renderTemplate('{first_name}, добрый день!', { name: '79200255591' })).toBe('Добрый день!');
  });
});

describe('buildRenderCtx', () => {
  test('собирает контекст из снимка', () => {
    const snap = { visitAt: Date.parse('2026-10-20T13:30:00+03:00'), seanceLength: 3600, services: [{ id: 1, title: 'Пилинг' }, { id: 2, title: 'Маска' }],
      staffName: 'Татьяна', clientName: 'Анна', shortLink: 'https://yc.gl/c/x' };
    const c = buildRenderCtx(snap, { name: 'PERI CLINIC' }, null, {});
    expect(c).toMatchObject({ date: '20.10.2026', time: '13:30', end_time: '14:30', services: 'Пилинг, Маска', staff: 'Татьяна', salon: 'PERI CLINIC', record_link: 'https://yc.gl/c/x', name: 'Анна' });
  });
  test('имя из карточки клиента главнее имени в вебхуке', () => {
    const c = buildRenderCtx({ visitAt: null, services: [], clientName: 'Аня' }, { name: 'S' }, { name: 'Иванова Анна' }, {});
    expect(c.name).toBe('Иванова Анна');
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest notifications-render`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Создать `render.js`**

```js
'use strict';
// Рендер шаблона уведомления. Плейсхолдеры: {name} {first_name} {date} {time}
// {end_time} {services} {staff} {salon} {record_link} {rating_links}.
const { resolveGivenName } = require('../../utils/person-name');
const { MSK_OFFSET_MS } = require('./events');

function fmtMsk(ms) {
  if (ms == null) return { date: '', time: '' };
  const d = new Date(ms + MSK_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
  };
}

function renderTemplate(text, ctx) {
  if (!text) return '';
  const c = ctx || {};
  const firstName = resolveGivenName(c.name, { dictionary: c.nameDictionary }) || '';
  return String(text)
    .replace(/\{name\}/g, c.name || '')
    .replace(/\{first_name\}/g, firstName)
    .replace(/\{date\}/g, c.date || '')
    .replace(/\{time\}/g, c.time || '')
    .replace(/\{end_time\}/g, c.end_time || '')
    .replace(/\{services\}/g, c.services || '')
    .replace(/\{staff\}/g, c.staff || '')
    .replace(/\{salon\}/g, c.salon || '')
    .replace(/\{record_link\}/g, c.record_link || '')
    .replace(/\{rating_links\}/g, c.rating_links || '')
    // «{first_name}, добрый день!» без имени → «Добрый день!», а не «, добрый день!»
    .replace(/^[ \t]*,\s*(\p{L})/gmu, (_, ch) => ch.toUpperCase());
}

/**
 * snap — events.recordSnapshot; salon — строка salons; client — строка clients|null;
 * extra — {nameDictionary, rating_links}.
 */
function buildRenderCtx(snap, salon, client, extra) {
  const start = fmtMsk(snap.visitAt);
  const end = fmtMsk(snap.visitAt != null ? snap.visitAt + (snap.seanceLength || 0) * 1000 : null);
  return {
    name: (client && client.name) || snap.clientName || '',
    nameDictionary: extra && extra.nameDictionary,
    date: start.date, time: start.time, end_time: end.time,
    services: (snap.services || []).map((s) => s.title).filter(Boolean).join(', '),
    staff: snap.staffName || '',
    salon: (salon && salon.name) || '',
    record_link: snap.shortLink || '',
    rating_links: (extra && extra.rating_links) || '',
  };
}

module.exports = { renderTemplate, buildRenderCtx, fmtMsk };
```

- [ ] **Step 4: Создать `rules.js`** — ПЕРЕНЕСТИ без изменений из `services/notifications.js` функции `evaluateRule`, `resolveRouting`, константу `ALLOWED_CHANNELS`, `getServiceCategoryMap` (с кэшем `_catMapCache`/`CAT_MAP_TTL`), `lastIncomingChannel`, `splitVisitDatetime`. Импорты: `const { db } = require('../../db'); const chatpush = require('../chatpush'); const { ycGet } = require('../yclients');`. Экспорт: `{ evaluateRule, resolveRouting, ALLOWED_CHANNELS, getServiceCategoryMap, lastIncomingChannel, splitVisitDatetime }`.

- [ ] **Step 5: Фасад** — в `services/notifications.js` удалить перенесённые функции и `renderTemplate`, вместо них в начале файла:

```js
const rules = require('./notifications/rules');
const render = require('./notifications/render');
const { evaluateRule, resolveRouting, ALLOWED_CHANNELS, getServiceCategoryMap, lastIncomingChannel, splitVisitDatetime } = rules;
const { renderTemplate } = render;
```

`module.exports` оставить тем же набором имён (значения теперь из модулей). Воркер и `handleRecordCreated` пока не трогать.

- [ ] **Step 6: Тесты**

Run: `cd /root/loyalpro/backend && npx jest notifications-render notifications care-worker reminders-worker`
Expected: PASS (care/reminders импортируют `getServiceCategoryMap`/`lastIncomingChannel` через фасад).

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro && git add backend/services/notifications.js backend/services/notifications/render.js backend/services/notifications/rules.js backend/notifications-render.test.js
git commit -m "refactor(notifications): чистые помощники v1 вынесены в services/notifications/, новые плейсхолдеры

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `settings.js` и `enroll.js` — состояние записи и постановка job'ов; хук в вебхуке YClients

**Files:**
- Create: `backend/services/notifications/settings.js`, `backend/services/notifications/enroll.js`
- Modify: `backend/services/notifications.js` (экспорт `handleRecordEvent`, алиас `handleRecordCreated`)
- Modify: `backend/routes/webhook.js:5,80-84`
- Test: `backend/notifications-enroll.test.js`

- [ ] **Step 1: `settings.js`**

```js
'use strict';
// Настройки модуля уведомлений по салону (notification_settings). Строки нет →
// дефолты (режим off). Кэш 30 с: читается на каждом вебхуке и каждом входящем.
const { db } = require('../../db');

const DEFAULTS = Object.freeze({
  mode: 'off',
  default_channels: ['tdlib', 'whatsapp', 'max'],
  quiet_from: '21:00',
  quiet_to: '09:00',
  confirm_reply_text: '✅ Ваша запись подтверждена.\nБудем ждать вас!',
  rating_high_text: 'Спасибо за отличную оценку нашей работы! 🙏🏻',
  rating_mid_text: 'Спасибо за оценку! Подскажите, пожалуйста, что нам стоит улучшить? Мы обязательно учтём.',
  rating_low_text: 'Благодарим Вас за оценку.\nНе могли бы Вы рассказать, что именно Вас не устроило? Мы постараемся принять меры и, по возможности, исправить данную ситуацию.',
  rating_escalate_low: true,
});
const MODES = ['off', 'shadow', 'live'];
const TTL_MS = 30 * 1000;
const cache = new Map();

async function getSettings(salonId) {
  const hit = cache.get(salonId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const row = await db.oneOrNone('SELECT * FROM notification_settings WHERE salon_id = $1', [salonId]);
  const value = Object.freeze({ ...DEFAULTS, ...(row || {}), salon_id: salonId });
  cache.set(salonId, { at: Date.now(), value });
  return value;
}

function hm(v) {
  if (v == null || v === '') return null;
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(v))) { const e = new Error('bad time'); e.code = 'BAD_TIME'; throw e; }
  return String(v);
}

async function updateSettings(salonId, patch) {
  const cur = await getSettings(salonId);
  const next = {
    mode: MODES.includes(patch.mode) ? patch.mode : cur.mode,
    default_channels: Array.isArray(patch.default_channels) ? patch.default_channels.map(String) : cur.default_channels,
    quiet_from: 'quiet_from' in patch ? hm(patch.quiet_from) : cur.quiet_from,
    quiet_to: 'quiet_to' in patch ? hm(patch.quiet_to) : cur.quiet_to,
    confirm_reply_text: typeof patch.confirm_reply_text === 'string' ? patch.confirm_reply_text.slice(0, 2000) : cur.confirm_reply_text,
    rating_high_text: typeof patch.rating_high_text === 'string' ? patch.rating_high_text.slice(0, 2000) : cur.rating_high_text,
    rating_mid_text: typeof patch.rating_mid_text === 'string' ? patch.rating_mid_text.slice(0, 2000) : cur.rating_mid_text,
    rating_low_text: typeof patch.rating_low_text === 'string' ? patch.rating_low_text.slice(0, 2000) : cur.rating_low_text,
    rating_escalate_low: typeof patch.rating_escalate_low === 'boolean' ? patch.rating_escalate_low : cur.rating_escalate_low,
  };
  await db.query(
    `INSERT INTO notification_settings (salon_id, mode, default_channels, quiet_from, quiet_to,
        confirm_reply_text, rating_high_text, rating_mid_text, rating_low_text, rating_escalate_low, updated_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (salon_id) DO UPDATE SET mode=EXCLUDED.mode, default_channels=EXCLUDED.default_channels,
        quiet_from=EXCLUDED.quiet_from, quiet_to=EXCLUDED.quiet_to, confirm_reply_text=EXCLUDED.confirm_reply_text,
        rating_high_text=EXCLUDED.rating_high_text, rating_mid_text=EXCLUDED.rating_mid_text,
        rating_low_text=EXCLUDED.rating_low_text, rating_escalate_low=EXCLUDED.rating_escalate_low, updated_at=NOW()`,
    [salonId, next.mode, JSON.stringify(next.default_channels), next.quiet_from, next.quiet_to,
     next.confirm_reply_text, next.rating_high_text, next.rating_mid_text, next.rating_low_text, next.rating_escalate_low]);
  cache.delete(salonId);
  return getSettings(salonId);
}

function invalidate() { cache.clear(); }
module.exports = { getSettings, updateSettings, invalidate, DEFAULTS, MODES };
```

- [ ] **Step 2: Падающие тесты enroll**

```js
'use strict';
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn(), query: jest.fn() } }));
jest.mock('./services/notifications/settings', () => ({ getSettings: jest.fn() }));
jest.mock('./services/notifications/rules', () => ({
  ...jest.requireActual('./services/notifications/rules'),
  getServiceCategoryMap: jest.fn(async () => new Map([['1', '10']])),
}));
jest.mock('./utils/salon-names', () => ({ load: jest.fn(async () => null) }));
const { db } = require('./db');
const settings = require('./services/notifications/settings');
const enroll = require('./services/notifications/enroll');

const salon = { id: 1, name: 'PERI CLINIC', yclients_company_id: 5 };
const NOW = Date.parse('2026-10-18T10:00:00+03:00');
const payload = (over = {}, status = 'create') => ({ status, data: {
  id: 100, datetime: '2026-10-20T13:30:00+03:00', seance_length: 3600, attendance: 0, deleted: false, sms_before: 24,
  client: { id: 7, phone: '79200255591', name: 'Анна' }, staff: { id: 55, name: 'Татьяна' },
  services: [{ id: 1, title: 'Пилинг' }], created_user_id: 13287477, ...over } });
const rule = (over) => ({ id: 1, title: 'r', trigger_type: 'record_created', conditions: { logic: 'and', items: [] },
  message_template: '{first_name}, вы записаны {date} {time}', channels: ['tdlib'], prefer_last_channel: true,
  hours_before: 24, delay_minutes: 5, on_no_show: true, ask_confirmation: true, ...over });

function setup({ prev = null, rules = [], client = { id: 9, name: 'Иванова Анна', is_blacklisted: false }, mode = 'live' } = {}) {
  settings.getSettings.mockResolvedValue({ mode, quiet_from: null, quiet_to: null, default_channels: ['tdlib'] });
  db.oneOrNone.mockImplementation(async (sql) => {
    if (/FROM notification_record_state/.test(sql)) return prev;
    if (/FROM clients/.test(sql)) return client;
    if (/FROM records/.test(sql)) return { n: '0' };
    return null;
  });
  db.any.mockImplementation(async (sql) => (/FROM notification_rules/.test(sql) ? rules : []));
  db.query.mockResolvedValue({ rowCount: 1, rows: [{ id: 1 }] });
}
const inserts = () => db.query.mock.calls.filter(([sql]) => /INSERT INTO notification_jobs/.test(sql)).map(([, p]) => p);

beforeEach(() => { jest.clearAllMocks(); });

test('режим off → состояние пишется, job не создаётся', async () => {
  setup({ mode: 'off', rules: [rule()] });
  await enroll.handleRecordEvent(salon, payload(), NOW);
  expect(db.query.mock.calls.some(([sql]) => /INSERT INTO notification_record_state/.test(sql))).toBe(true);
  expect(inserts()).toHaveLength(0);
});

test('create → record_created немедленно + visit_reminder за 24 ч', async () => {
  setup({ rules: [rule(), rule({ id: 2, trigger_type: 'visit_reminder' })] });
  await enroll.handleRecordEvent(salon, payload(), NOW);
  const rows = inserts();
  expect(rows).toHaveLength(2);
  const [created, reminder] = rows;
  expect(created[2]).toBe('record_created');
  expect(created[8]).toBe('Анна, вы записаны 20.10.2026 13:30');
  expect(reminder[2]).toBe('visit_reminder');
  expect(new Date(reminder[6]).getTime()).toBe(Date.parse('2026-10-19T13:30:00+03:00'));
});

test('условия правила не совпали → job нет', async () => {
  setup({ rules: [rule({ conditions: { logic: 'and', items: [{ type: 'staff', ids: [999] }] } })] });
  await enroll.handleRecordEvent(salon, payload(), NOW);
  expect(inserts()).toHaveLength(0);
});

test('запись, созданная Милой (интеграционный пользователь), получает «Вы записаны» как любая', async () => {
  setup({ rules: [rule()] });
  await enroll.handleRecordEvent(salon, payload({ created_user_id: 12017996 }), NOW);
  expect(inserts()[0][9]).toBe('pending');
});

test('тихие часы сдвигают опрос, но не «Вы записаны»', async () => {
  const prev = { visit_datetime: new Date('2026-10-20T20:00:00+03:00'), attendance: 0, deleted: false };
  setup({ prev, rules: [rule({ id: 5, trigger_type: 'visit_review', delay_minutes: 5 })] });
  settings.getSettings.mockResolvedValue({ mode: 'live', quiet_from: '21:00', quiet_to: '09:00', default_channels: ['tdlib'] });
  const late = Date.parse('2026-10-20T21:10:00+03:00');
  await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-20T20:00:00+03:00', attendance: 1 }, 'update'), late);
  expect(new Date(inserts()[0][6]).getTime()).toBe(Date.parse('2026-10-21T09:00:00+03:00'));
  jest.clearAllMocks();
  setup({ rules: [rule()] });
  settings.getSettings.mockResolvedValue({ mode: 'live', quiet_from: '21:00', quiet_to: '09:00', default_channels: ['tdlib'] });
  const night = Date.parse('2026-10-20T23:30:00+03:00');
  await enroll.handleRecordEvent(salon, payload(), night);
  expect(new Date(inserts()[0][6]).getTime()).toBe(night);
});

test('чёрный список → skipped', async () => {
  setup({ rules: [rule()], client: { id: 9, name: 'X', is_blacklisted: true } });
  await enroll.handleRecordEvent(salon, payload(), NOW);
  expect(inserts()[0][9]).toBe('skipped');
});

test('перенос: гасит pending-напоминание записи и ставит новое + record_rescheduled', async () => {
  const prev = { visit_datetime: new Date('2026-10-20T13:30:00+03:00'), attendance: 0, deleted: false };
  setup({ prev, rules: [rule({ id: 3, trigger_type: 'record_rescheduled' }), rule({ id: 2, trigger_type: 'visit_reminder' })] });
  await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-21T10:00:00+03:00' }, 'update'), NOW);
  expect(db.query.mock.calls.some(([sql, p]) => /SET status='cancelled'/.test(sql) && p.includes(100))).toBe(true);
  expect(inserts().map((p) => p[2]).sort()).toEqual(['record_rescheduled', 'visit_reminder']);
});

test('отмена: record_cancelled + гашение всех pending записи; второй delete молчит', async () => {
  const prev = { visit_datetime: new Date('2026-10-20T13:30:00+03:00'), attendance: 0, deleted: false };
  setup({ prev, rules: [rule({ id: 4, trigger_type: 'record_cancelled' })] });
  await enroll.handleRecordEvent(salon, payload({}, 'delete'), NOW);
  expect(inserts().map((p) => p[2])).toEqual(['record_cancelled']);
  jest.clearAllMocks();
  setup({ prev: { ...prev, deleted: true }, rules: [rule({ id: 4, trigger_type: 'record_cancelled' })] });
  await enroll.handleRecordEvent(salon, payload({}, 'delete'), NOW);
  expect(inserts()).toHaveLength(0);
});

test('«не пришёл» при on_no_show=false → без уведомления, но pending гасятся', async () => {
  const prev = { visit_datetime: new Date('2026-10-20T13:30:00+03:00'), attendance: 0, deleted: false };
  setup({ prev, rules: [rule({ id: 4, trigger_type: 'record_cancelled', on_no_show: false })] });
  await enroll.handleRecordEvent(salon, payload({ attendance: -1 }, 'update'), NOW);
  expect(inserts()).toHaveLength(0);
  expect(db.query.mock.calls.some(([sql]) => /SET status='cancelled'/.test(sql))).toBe(true);
});

test('пришёл → visit_review через delay от конца визита, visit_after по условиям, first_visit при 0 прошлых', async () => {
  const prev = { visit_datetime: new Date('2026-10-20T13:30:00+03:00'), attendance: 0, deleted: false };
  const later = Date.parse('2026-10-20T13:40:00+03:00');
  setup({ prev, rules: [
    rule({ id: 5, trigger_type: 'visit_review', delay_minutes: 5 }),
    rule({ id: 6, trigger_type: 'visit_after', delay_minutes: 7, attachment_url: '/uploads/a.jpg', conditions: { logic: 'and', items: [{ type: 'category', ids: [10] }] } }),
    rule({ id: 7, trigger_type: 'visit_after', delay_minutes: 7, conditions: { logic: 'and', items: [{ type: 'category', ids: [99] }] } }),
    rule({ id: 8, trigger_type: 'first_visit' }),
  ] });
  await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), later);
  const rows = inserts();
  expect(rows.map((p) => p[2]).sort()).toEqual(['first_visit', 'visit_after', 'visit_review']);
  const review = rows.find((p) => p[2] === 'visit_review');
  expect(new Date(review[6]).getTime()).toBe(Date.parse('2026-10-20T14:35:00+03:00'));
  const after = rows.find((p) => p[2] === 'visit_after');
  expect(after[11]).toBe('/uploads/a.jpg');
});

test('first_visit не ставится, если были прошлые состоявшиеся визиты', async () => {
  const prev = { visit_datetime: new Date('2026-10-20T13:30:00+03:00'), attendance: 0, deleted: false };
  setup({ prev, rules: [rule({ id: 8, trigger_type: 'first_visit' })] });
  db.oneOrNone.mockImplementation(async (sql) => (/FROM records/.test(sql) ? { n: '2' } : (/FROM notification_record_state/.test(sql) ? prev : { id: 9, name: 'A', is_blacklisted: false })));
  await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), NOW);
  expect(inserts()).toHaveLength(0);
});
```

- [ ] **Step 3: Убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest notifications-enroll`
Expected: FAIL — модуль `enroll` не найден.

- [ ] **Step 4: `enroll.js`**

```js
'use strict';
// ============================================================
// handleRecordEvent(salon, payload, nowMs) — зовётся из routes/webhook.js на
// КАЖДОМ record-событии YClients. Обновляет notification_record_state, по
// разнице со старым состоянием классифицирует событие и ставит job'ы по
// совпавшим правилам. Пропуски (нет телефона, ЧС, запись Милы) — строки
// skipped с причиной: «почему не пришло» разбирается по журналу.
// Режим off → только состояние (нужно, чтобы при включении shadow/live перенос
// и «пришёл» распознавались сразу, а не с первого события после включения).
// ============================================================
const { db } = require('../../db');
const { createLogger } = require('../../logger');
const settingsSvc = require('./settings');
const ev = require('./events');
const { evaluateRule, getServiceCategoryMap } = require('./rules');
const { renderTemplate, buildRenderCtx } = require('./render');
const salonNames = require('../../utils/salon-names');

const log = createLogger('NotifyEnroll');

const IMMEDIATE = { created: 'record_created', rescheduled: 'record_rescheduled', cancelled: 'record_cancelled' };

async function loadState(salonId, recordId) {
  const row = await db.oneOrNone(
    'SELECT * FROM notification_record_state WHERE salon_id = $1 AND yclients_record_id = $2', [salonId, recordId]);
  if (!row) return null;
  return { ...row, visitAt: row.visit_datetime ? new Date(row.visit_datetime).getTime() : null };
}

async function saveState(salonId, snap) {
  await db.query(
    `INSERT INTO notification_record_state (salon_id, yclients_record_id, visit_datetime, seance_length, attendance, deleted,
        services, staff_id, client_yc_id, phone, created_user_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,NOW())
     ON CONFLICT (salon_id, yclients_record_id) DO UPDATE SET visit_datetime=EXCLUDED.visit_datetime,
        seance_length=EXCLUDED.seance_length, attendance=EXCLUDED.attendance, deleted=EXCLUDED.deleted,
        services=EXCLUDED.services, staff_id=EXCLUDED.staff_id, client_yc_id=EXCLUDED.client_yc_id,
        phone=COALESCE(EXCLUDED.phone, notification_record_state.phone), created_user_id=EXCLUDED.created_user_id, updated_at=NOW()`,
    [salonId, snap.recordId, snap.visitAt != null ? new Date(snap.visitAt) : null, snap.seanceLength, snap.attendance,
     snap.deleted, JSON.stringify(snap.services), snap.staffId, snap.clientYcId, snap.phone, snap.createdUserId]);
}

async function cancelPending(salonId, recordId, reason, onlyTypes = null) {
  const res = await db.query(
    `UPDATE notification_jobs SET status='cancelled', decision_reason=$3
      WHERE salon_id=$1 AND yclients_record_id=$2 AND status='pending'
        AND ($4::text[] IS NULL OR trigger_type = ANY($4::text[]))`,
    [salonId, recordId, reason, onlyTypes]);
  return res.rowCount || 0;
}

async function insertJob(salonId, rule, snap, client, scheduledMs, text, extra = {}) {
  const res = await db.query(
    `INSERT INTO notification_jobs (salon_id, rule_id, trigger_type, rule_title, yclients_record_id, visit_datetime, scheduled_at,
        client_id, rendered_text, status, phone, attachment_url, meta, decision_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
     ON CONFLICT (rule_id, yclients_record_id, COALESCE(visit_datetime, 'epoch'::timestamptz)) DO NOTHING`,
    [salonId, rule.id, rule.trigger_type, rule.title, snap.recordId,
     snap.visitAt != null ? new Date(snap.visitAt) : null, new Date(scheduledMs),
     client ? client.id : null, text, extra.status || 'pending', snap.phone, rule.attachment_url || null,
     JSON.stringify({ askConfirmation: !!rule.ask_confirmation, ...(extra.meta || {}) }),
     extra.reason || null]);
  if (res.rowCount) log.info(`job ${rule.trigger_type} rule=${rule.id} record=${snap.recordId} → ${extra.status || 'pending'}${extra.reason ? ': ' + extra.reason : ''}`);
  return res.rowCount || 0;
}

async function priorArrivedVisits(salonId, clientId, beforeMs) {
  if (!clientId) return 0;
  const row = await db.oneOrNone(
    `SELECT count(*)::int AS n FROM records
      WHERE salon_id = $1 AND client_id = $2 AND status = 'arrived' AND visit_datetime < $3`,
    [salonId, clientId, new Date(beforeMs)]);
  return row ? Number(row.n) : 0;
}

async function handleRecordEvent(salon, payload, nowMs = Date.now()) {
  const snap = ev.recordSnapshot(payload);
  if (!Number.isInteger(snap.recordId)) return;
  const salonId = salon.id;
  const prev = await loadState(salonId, snap.recordId);
  const kinds = ev.classifyRecordEvent(prev, snap);
  await saveState(salonId, snap);

  const cfg = await settingsSvc.getSettings(salonId);
  if (cfg.mode === 'off') return;

  // Отмена/перенос гасят запланированное ВСЕГДА, даже без правил на эти события.
  if (kinds.cancelled) await cancelPending(salonId, snap.recordId, 'запись отменена');
  if (kinds.rescheduled) await cancelPending(salonId, snap.recordId, 'запись перенесена', ['visit_reminder', 'first_visit']);

  const rules = await db.any(
    'SELECT * FROM notification_rules WHERE salon_id = $1 AND is_enabled = TRUE', [salonId]);
  if (!rules.length) return;

  const catMap = await getServiceCategoryMap(salon).catch(() => new Map());
  const serviceIds = snap.services.map((s) => s.id);
  const ctx = { staffId: snap.staffId, serviceIds,
    categoryIds: [...new Set(serviceIds.map((id) => catMap.get(String(id))).filter(Boolean))] };
  const matches = (r) => { try { return evaluateRule(r.conditions, ctx); } catch (e) { log.warn(`rule #${r.id}: ${e.message}`); return false; } };

  const client = snap.clientYcId ? await db.oneOrNone(
    'SELECT id, name, is_blacklisted FROM clients WHERE salon_id = $1 AND yclients_client_id = $2', [salonId, snap.clientYcId]) : null;
  const renderCtx = buildRenderCtx(snap, salon, client, { nameDictionary: await salonNames.load(salonId).catch(() => null) });

  const skipReasonFor = (rule) => {
    if (!snap.phone) return 'нет телефона клиента';
    if (client && client.is_blacklisted) return 'клиент в чёрном списке';
    return null;
  };
  const put = async (rule, atMs, meta) => {
    const reason = skipReasonFor(rule);
    const text = renderTemplate(rule.message_template, renderCtx);
    return insertJob(salonId, rule, snap, client, atMs, text, reason ? { status: 'skipped', reason } : { meta });
  };

  for (const rule of rules) {
    const t = rule.trigger_type;
    if (IMMEDIATE.created === t && kinds.created && matches(rule)) await put(rule, nowMs);
    if (IMMEDIATE.rescheduled === t && kinds.rescheduled && matches(rule)) await put(rule, nowMs);
    if (IMMEDIATE.cancelled === t && kinds.cancelled && (!kinds.noShow || rule.on_no_show) && matches(rule)) await put(rule, nowMs);

    if (t === 'visit_reminder' && (kinds.created || kinds.rescheduled) && matches(rule)) {
      const at = ev.reminderAt(snap, rule, cfg, nowMs);
      if (at != null) await put(rule, at); else log.info(`reminder rule=${rule.id} record=${snap.recordId}: момент уже прошёл — не ставим`);
    }
    if (t === 'visit_review' && kinds.arrived && matches(rule)) {
      await put(rule, ev.applyQuietHours(ev.afterVisitAt(snap, rule.delay_minutes || 5, nowMs), cfg));
    }
    if (t === 'visit_after' && kinds.arrived && matches(rule)) {
      await put(rule, ev.applyQuietHours(ev.afterVisitAt(snap, rule.delay_minutes || 7, nowMs), cfg));
    }
    if (t === 'first_visit' && kinds.arrived && matches(rule)) {
      const prior = await priorArrivedVisits(salonId, client && client.id, snap.visitAt || nowMs);
      if (prior === 0) await put(rule, nowMs); else log.info(`first_visit rule=${rule.id} record=${snap.recordId}: уже был ${prior} визит(ов) — пропуск`);
    }
  }
}

module.exports = { handleRecordEvent, cancelPending, _loadState: loadState };
```

Примечание к `first_visit`: Chatpush слал приглашение в момент начала первого визита; мы ставим при статусе «пришёл» (администратор отмечает его при входе пациента) — на минуты позже, зато без ложных отправок по записям, на которые клиент не пришёл.

- [ ] **Step 5: Тесты зелёные**

Run: `cd /root/loyalpro/backend && npx jest notifications-enroll`
Expected: PASS, 11 тестов. Если индекс параметров в `insertJob` разошёлся с ожиданиями (`[2]` trigger, `[6]` scheduled_at, `[8]` text, `[9]` status, `[11]` attachment) — поправить ТЕСТ под реальный порядок, не наоборот.

- [ ] **Step 6: Фасад и хук вебхука**

В `services/notifications.js`: `const enroll = require('./notifications/enroll');` и в `module.exports` добавить `handleRecordEvent: enroll.handleRecordEvent`; старый `handleRecordCreated` удалить вместе с его телом (v1-правила `record_created` теперь ведёт `enroll`).

В `routes/webhook.js` строку 5 заменить на `const { handleRecordEvent } = require('../services/notifications');`, а блок строк 80–84 на:

```js
      // Уведомления клиенту по ЛЮБОМУ событию записи (создание/перенос/отмена/
      // пришёл → напоминание, опрос, рекомендации). Свой catch — сбой не должен
      // ломать начисления.
      await handleRecordEvent(salon, payload).catch(e =>
        logger.error(`notifications: ${e.message}`));
```

- [ ] **Step 7: Проверить, что ничего не сломано**

Run: `cd /root/loyalpro/backend && npx jest notifications webhook 2>&1 | tail -5`
Expected: PASS (сьюты вебхука, если есть, мокают `handleRecordCreated` — заменить мок на `handleRecordEvent`).

- [ ] **Step 8: Commit**

```bash
cd /root/loyalpro && git add backend/services/notifications/settings.js backend/services/notifications/enroll.js backend/services/notifications.js backend/routes/webhook.js backend/notifications-enroll.test.js
git commit -m "feat(notifications): состояние записи и постановка job'ов по событиям YClients (создание/перенос/отмена/пришёл)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Воркер `worker.js` — аренда, перепроверка, тень/боевой, каскад мессенджеров

**Files:**
- Create: `backend/services/notifications/worker.js`
- Modify: `backend/services/messaging/transport.js:132` (экспорт `isDefiniteRejection`), `backend/services/notifications.js` (`startNotificationWorker` → новый воркер; старый `processTick` удалить)
- Test: `backend/notifications-worker.test.js`

- [ ] **Step 1: Экспорт `isDefiniteRejection`** — в `transport.js` последнюю строку заменить на `module.exports = { sendMessage, sendFile, getDeliveryStatus, configured, isDefiniteRejection };`.

- [ ] **Step 2: Падающие тесты воркера**

```js
'use strict';
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn(), query: jest.fn() } }));
jest.mock('./services/messaging/transport', () => ({
  sendMessage: jest.fn(), sendFile: jest.fn(), configured: () => true,
  isDefiniteRejection: (e) => !!(e && e.status >= 400 && e.status < 500),
}));
jest.mock('./services/notifications/settings', () => ({ getSettings: jest.fn() }));
jest.mock('./services/notifications/rules', () => ({ lastIncomingChannel: jest.fn(async () => null), resolveRouting: jest.requireActual('./services/notifications/rules').resolveRouting, ALLOWED_CHANNELS: ['telegram','whatsapp','tdlib','max','max_bot','notify'] }));
jest.mock('./services/agent/pending-replies', () => ({ remember: jest.fn() }));
jest.mock('./services/outgoing-authorship', () => ({ remember: jest.fn(async () => {}) }));
jest.mock('./services/chat-persist', () => ({ persistWhatsappOutgoing: jest.fn(async () => {}) }));
jest.mock('fs', () => ({ ...jest.requireActual('fs'), readFileSync: jest.fn(() => Buffer.from('img')), existsSync: () => true }));

const { db } = require('./db');
const transport = require('./services/messaging/transport');
const settings = require('./services/notifications/settings');
const authorship = require('./services/outgoing-authorship');
const worker = require('./services/notifications/worker');

const job = (over = {}) => ({ id: 1, salon_id: 1, rule_id: 1, trigger_type: 'record_created', yclients_record_id: 100,
  visit_datetime: new Date('2026-10-20T13:30:00+03:00'), phone: '79200255591', rendered_text: 'Текст',
  attachment_url: null, attempts: 1, meta: {}, channels: ['tdlib', 'whatsapp'], prefer_last_channel: true, ...over });
const state = (over = {}) => ({ visit_datetime: new Date('2026-10-20T13:30:00+03:00'), attendance: 0, deleted: false, ...over });

function setup({ jobs, st = state(), mode = 'live', captured = 1 } = {}) {
  settings.getSettings.mockResolvedValue({ mode, default_channels: ['tdlib', 'whatsapp'] });
  db.any.mockImplementation(async (sql) => (/UPDATE notification_jobs/.test(sql) ? jobs : []));
  db.oneOrNone.mockImplementation(async (sql) => (/FROM notification_record_state/.test(sql) ? st : (/FROM clients/.test(sql) ? { is_blacklisted: false } : null)));
  db.query.mockImplementation(async (sql) => ({ rowCount: /SET status='sent'/.test(sql) ? captured : 1, rows: [] }));
  transport.sendMessage.mockResolvedValue({ id: 555, channel: 'tdlib' });
  transport.sendFile.mockResolvedValue({ id: 556, channel: 'tdlib' });
}
const statusUpdates = () => db.query.mock.calls.map(([sql, p]) => ({ sql, p })).filter((c) => /UPDATE notification_jobs/.test(c.sql));
beforeEach(() => jest.clearAllMocks());

test('live: отправка, журнал sent, персист в транскрипт как system', async () => {
  setup({ jobs: [job()] });
  await worker.processTick();
  expect(transport.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ text: 'Текст', phone: '79200255591', dispatchRouting: ['tdlib', 'whatsapp'] }));
  expect(statusUpdates().some((c) => /SET status='sent'/.test(c.sql))).toBe(true);
  expect(authorship.remember).toHaveBeenCalledWith(1, '79200255591', 'Текст', 'system');
});

test('shadow: отправки нет, строка shadow с текстом', async () => {
  setup({ jobs: [job()], mode: 'shadow' });
  await worker.processTick();
  expect(transport.sendMessage).not.toHaveBeenCalled();
  expect(statusUpdates().some((c) => /SET status='shadow'/.test(c.sql))).toBe(true);
});

test('off: строка откладывается без отправки (pending)', async () => {
  setup({ jobs: [job()], mode: 'off' });
  await worker.processTick();
  expect(transport.sendMessage).not.toHaveBeenCalled();
  expect(statusUpdates().some((c) => /SET status='sent'|SET status='shadow'/.test(c.sql))).toBe(false);
});

test('напоминание: запись перенесена после постановки → cancelled, без отправки', async () => {
  setup({ jobs: [job({ trigger_type: 'visit_reminder' })], st: state({ visit_datetime: new Date('2026-10-21T10:00:00+03:00') }) });
  await worker.processTick();
  expect(transport.sendMessage).not.toHaveBeenCalled();
  expect(statusUpdates().some((c) => /SET status='cancelled'/.test(c.sql))).toBe(true);
});

test('опрос: клиент снят со статуса «пришёл» → cancelled', async () => {
  setup({ jobs: [job({ trigger_type: 'visit_review' })], st: state({ attendance: 0 }) });
  await worker.processTick();
  expect(transport.sendMessage).not.toHaveBeenCalled();
});

test('вложение → sendFile с подписью', async () => {
  setup({ jobs: [job({ trigger_type: 'visit_after', attachment_url: '/uploads/notify_1_6_1.jpg' })] });
  await worker.processTick();
  expect(transport.sendFile).toHaveBeenCalledWith(1, expect.objectContaining({ caption: 'Текст', type: 'image', fileName: 'notify_1_6_1.jpg' }), expect.any(Buffer), 'image/jpeg');
  expect(transport.sendMessage).not.toHaveBeenCalled();
});

test('все мессенджеры отказали (4xx), попытка не последняя → строка снова pending для повтора', async () => {
  setup({ jobs: [job({ attempts: 1 })] });
  transport.sendMessage.mockRejectedValue(Object.assign(new Error('422'), { status: 422 }));
  await worker.processTick();
  expect(statusUpdates().some((c) => /SET status=\$2/.test(c.sql) && c.p[1] === 'pending')).toBe(true);
});

test('таймаут транспорта → без повтора (сообщение могло уйти), строка failed', async () => {
  setup({ jobs: [job()] });
  transport.sendMessage.mockRejectedValue(new Error('timeout'));
  await worker.processTick();
  expect(statusUpdates().some((c) => /SET status=\$2/.test(c.sql) && c.p[1] === 'failed')).toBe(true);
});

test('захват не удался (строку уже отменили) → отправки нет', async () => {
  setup({ jobs: [job()], captured: 0 });
  await worker.processTick();
  expect(transport.sendMessage).not.toHaveBeenCalled();
});

test('тестовая строка (meta.test) не перепроверяет состояние записи', async () => {
  setup({ jobs: [job({ trigger_type: 'visit_reminder', yclients_record_id: 0, meta: { test: true } })], st: null });
  await worker.processTick();
  expect(transport.sendMessage).toHaveBeenCalled();
});
```

- [ ] **Step 3: Убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest notifications-worker`
Expected: FAIL — модуль не найден.

- [ ] **Step 4: `worker.js`**

```js
'use strict';
// ============================================================
// Воркер уведомлений: аренда due-строк notification_jobs, перепроверка состояния
// записи ПЕРЕД отправкой (напоминание о перенесённой/отменённой записи — хуже
// молчания), режим салона (off → ждём, shadow → журнал без отправки, live →
// отправка), захват mark-before-send (at-most-once, как в «Заботе»), каскад
// каналов через transport; повтор только при ОДНОЗНАЧНОМ отказе (4xx), таймаут/5xx — failed.
// ============================================================
const fs = require('fs');
const path = require('path');
const { db } = require('../../db');
const transport = require('../messaging/transport');
const settingsSvc = require('./settings');
const { resolveRouting, lastIncomingChannel } = require('./rules');
const pendingReplies = require('../agent/pending-replies');
const authorship = require('../outgoing-authorship');
const { persistWhatsappOutgoing } = require('../chat-persist');
const { createLogger } = require('../../logger');

const log = createLogger('NotifyWorker');
const TICK_MS = 10 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_S = 60;
const BATCH = 10;
const uploadsDir = path.join(__dirname, '../../../frontend/uploads');
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' };

// Колонки правила — скалярными подзапросами: JOIN на цель UPDATE в PG запрещён
// («invalid reference to FROM-clause entry»); юнит-моки SQL не проверяют —
// после правки обязателен живой EXPLAIN на дев-БД.
const LEASE_SQL = `
  UPDATE notification_jobs j
     SET attempts = j.attempts + 1, last_attempt_at = NOW()
   WHERE j.id IN (
     SELECT id FROM notification_jobs
      WHERE status = 'pending' AND scheduled_at <= NOW()
        AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - make_interval(secs => $1))
      ORDER BY scheduled_at ASC, id ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED)
   RETURNING j.*,
     (SELECT r.channels FROM notification_rules r WHERE r.id = j.rule_id) AS channels,
     (SELECT r.prefer_last_channel FROM notification_rules r WHERE r.id = j.rule_id) AS prefer_last_channel`;

async function setStatus(id, status, extra = {}) {
  await db.query(
    `UPDATE notification_jobs SET status=$2, error=$3, decision_reason=COALESCE($4, decision_reason),
        routing=COALESCE($5::jsonb, routing), channel_used=COALESCE($6, channel_used), delivery_id=COALESCE($7, delivery_id)
      WHERE id=$1`,
    [id, status, extra.error || null, extra.reason || null, extra.routing ? JSON.stringify(extra.routing) : null,
     extra.channelUsed || null, extra.deliveryId != null ? String(extra.deliveryId) : null]);
}

/** Перепроверка по состоянию записи. Возвращает причину отмены или null. */
async function staleReason(job) {
  if (job.meta && job.meta.test) return null;
  const st = await db.oneOrNone(
    'SELECT visit_datetime, attendance, deleted FROM notification_record_state WHERE salon_id=$1 AND yclients_record_id=$2',
    [job.salon_id, job.yclients_record_id]);
  if (!st) return null;   // состояния нет (создано до выката) — не мешаем
  if (st.deleted || Number(st.attendance) === -1) return 'запись отменена к моменту отправки';
  const t = job.trigger_type;
  if ((t === 'visit_reminder' || t === 'first_visit') && job.visit_datetime && st.visit_datetime
      && new Date(st.visit_datetime).getTime() !== new Date(job.visit_datetime).getTime()) return 'запись перенесена к моменту отправки';
  if ((t === 'visit_review' || t === 'visit_after') && Number(st.attendance) !== 1) return 'статус «пришёл» снят';
  const cl = await db.oneOrNone('SELECT is_blacklisted FROM clients WHERE salon_id=$1 AND phone LIKE $2 LIMIT 1',
    [job.salon_id, '%' + String(job.phone || '').slice(-10)]);
  if (cl && cl.is_blacklisted) return 'клиент в чёрном списке';
  return null;
}

async function deliver(job, routing) {
  const base = { phone: job.phone, dispatchRouting: routing };
  if (job.attachment_url) {
    const fileName = path.basename(job.attachment_url);
    const abs = path.join(uploadsDir, fileName);
    if (!fs.existsSync(abs)) throw Object.assign(new Error(`файл вложения не найден: ${fileName}`), { status: 400 });
    const ext = path.extname(fileName).toLowerCase();
    const type = ext === '.pdf' ? 'document' : 'image';
    return transport.sendFile(job.salon_id, { ...base, fileName, caption: job.rendered_text, type }, fs.readFileSync(abs), MIME[ext] || 'application/octet-stream');
  }
  return transport.sendMessage(job.salon_id, { ...base, text: job.rendered_text });
}

async function afterSend(job, channelUsed, delivery) {
  try { pendingReplies.remember(job.salon_id, job.phone, job.rendered_text); } catch (e) { log.error(`pending #${job.id}: ${e.message}`); }
  await authorship.remember(job.salon_id, job.phone, job.rendered_text, 'system').catch((e) => log.error(`authorship #${job.id}: ${e.message}`));
  if (channelUsed === 'whatsapp' && delivery) {
    await persistWhatsappOutgoing(job.salon_id, { delivery, phone: job.phone, chatId: null, text: job.rendered_text,
      msgType: job.attachment_url ? 'image' : 'text', fileUrl: job.attachment_url || null, authoredBy: 'system' })
      .catch((e) => log.error(`persist wa #${job.id}: ${e.message}`));
  }
}

async function processOne(job, cfg) {
  if (cfg.mode === 'off') return;   // остаётся pending; вернётся после бэкоффа
  const stale = await staleReason(job);
  if (stale) { await setStatus(job.id, 'cancelled', { reason: stale }); log.info(`#${job.id} ${job.trigger_type} cancelled: ${stale}`); return; }

  const last = job.prefer_last_channel ? await lastIncomingChannel(job.salon_id, job.phone).catch(() => null) : null;
  const routing = resolveRouting(Array.isArray(job.channels) && job.channels.length ? job.channels : cfg.default_channels, job.prefer_last_channel, last);

  if (cfg.mode === 'shadow') {
    await setStatus(job.id, 'shadow', { routing, reason: 'теневой режим: не отправлено' });
    log.info(`#${job.id} ${job.trigger_type} shadow routing=[${routing.join(',')}]`);
    return;
  }

  // Захват ДО отправки: если строку отменили между арендой и этим моментом — не шлём.
  const cap = await db.query(
    `UPDATE notification_jobs SET status='sent', sent_at=NOW(), routing=$2::jsonb WHERE id=$1 AND status='pending'`,
    [job.id, JSON.stringify(routing)]);
  if (!cap.rowCount) { log.info(`#${job.id}: захват не удался — строка уже не pending`); return; }

  let delivered = false;
  try {
    const delivery = await deliver(job, routing);
    const channelUsed = (delivery && (delivery.channel || (Array.isArray(delivery.channels) && delivery.channels[0]))) || routing[0];
    delivered = true;
    await setStatus(job.id, 'sent', { channelUsed, deliveryId: delivery && delivery.id });
    log.info(`#${job.id} ${job.trigger_type} record=${job.yclients_record_id} sent via ${channelUsed} delivery=${delivery && delivery.id}`);
    await afterSend(job, channelUsed, delivery);
  } catch (e) {
    if (delivered) return;   // упала запись журнала после отправки — статус sent уже стоит с захвата
    const definite = transport.isDefiniteRejection(e);
    const final = job.attempts >= MAX_ATTEMPTS || !definite;   // таймаут/5xx: повторять нельзя — могло уйти
    await setStatus(job.id, final ? 'failed' : 'pending', { error: String(e.message || e).slice(0, 500) });
    log.warn(`#${job.id} attempt ${job.attempts}/${MAX_ATTEMPTS} failed (${definite ? '4xx' : 'не 4xx — без повтора'}): ${e.message}`);
  }
}

async function processTick() {
  const rows = await db.any(LEASE_SQL, [RETRY_BACKOFF_S, BATCH]);
  for (const row of rows) {
    try {
      const cfg = await settingsSvc.getSettings(row.salon_id);
      await processOne(row, cfg);
    } catch (e) {
      log.error(`#${row.id}: ${e.message}`);
      await setStatus(row.id, row.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', { error: String(e.message).slice(0, 500) }).catch(() => {});
    }
  }
}

let _running = false; let _inFlight = false;
function startNotificationWorker() {
  if (_running) return;
  _running = true;
  if (!transport.configured()) { log.warn('транспорт не настроен — notification worker disabled'); return; }
  setInterval(() => {
    if (_inFlight) return;
    _inFlight = true;
    processTick().catch((e) => log.error(`tick: ${e.message}`)).finally(() => { _inFlight = false; });
  }, TICK_MS);
  log.info(`Notification worker started (tick=${TICK_MS}ms)`);
}

module.exports = { processTick, processOne, startNotificationWorker, LEASE_SQL, staleReason };
```

- [ ] **Step 5: Фасад** — в `services/notifications.js` удалить `processTick`/старый `startNotificationWorker`/`lastIncomingChannel`-дубликаты и экспортировать `startNotificationWorker: require('./notifications/worker').startNotificationWorker`. Файл должен остаться тонким (≈30 строк): импорты папки и `module.exports` с прежними именами плюс `handleRecordEvent`.

- [ ] **Step 6: Тесты и живой EXPLAIN**

Run: `cd /root/loyalpro/backend && npx jest notifications-worker notifications-enroll notifications-render`
Expected: PASS.

Живой EXPLAIN (MCP `mcp__postgres__query`, дев-БД):
```sql
EXPLAIN UPDATE notification_jobs j SET attempts = j.attempts + 1, last_attempt_at = NOW()
 WHERE j.id IN (SELECT id FROM notification_jobs WHERE status='pending' AND scheduled_at <= NOW()
   AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - make_interval(secs => 60))
   ORDER BY scheduled_at ASC, id ASC LIMIT 10 FOR UPDATE SKIP LOCKED)
 RETURNING j.*, (SELECT r.channels FROM notification_rules r WHERE r.id = j.rule_id) AS channels,
   (SELECT r.prefer_last_channel FROM notification_rules r WHERE r.id = j.rule_id) AS prefer_last_channel
```
Expected: план без ошибки, `Index Scan using idx_notification_jobs_due`.

- [ ] **Step 7: Рестарт дева и проверка старта воркера**

Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 4 && pm2 logs loyalpro --lines 40 --nostream | grep -i "notification worker"`
Expected: `Notification worker started (tick=10000ms)`.

- [ ] **Step 8: Commit**

```bash
cd /root/loyalpro && git add backend/services/notifications/worker.js backend/services/notifications.js backend/services/messaging/transport.js backend/notifications-worker.test.js
git commit -m "feat(notifications): воркер очереди — перепроверка записи, теневой режим, каскад мессенджеров

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `replies.js` — «Подтверждаю» → статус в YClients, цифра → оценка; перехват в вебхуке мессенджера

**Files:**
- Create: `backend/services/notifications/replies.js`
- Modify: `backend/routes/chatpush-webhook.js:~315-335` (перед `dispatcher.enqueue`)
- Test: `backend/notifications-replies.test.js`

- [ ] **Step 1: Падающие тесты**

```js
'use strict';
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn(), query: jest.fn() } }));
jest.mock('./services/notifications/settings', () => ({ getSettings: jest.fn() }));
jest.mock('./services/agent/history', () => ({ lastOutgoing: jest.fn() }));
jest.mock('./services/yclients-records', () => ({ updateAttendance: jest.fn() }));
jest.mock('./services/messaging/transport', () => ({ sendMessage: jest.fn(async () => ({ id: 1, channel: 'tdlib' })) }));
jest.mock('./services/agent/pending-replies', () => ({ remember: jest.fn() }));
jest.mock('./services/outgoing-authorship', () => ({ remember: jest.fn(async () => {}) }));
jest.mock('./services/chat-persist', () => ({ persistWhatsappOutgoing: jest.fn(async () => {}) }));
jest.mock('./services/agent/dialog-state', () => ({ getOrCreate: jest.fn(async () => ({})), setStatus: jest.fn(async () => {}) }));
jest.mock('./services/chat-events', () => ({ emitAgentStatus: jest.fn() }));
jest.mock('./services/agent/followup-queue', () => ({ close: jest.fn(async () => 0) }));

const { db } = require('./db');
const settings = require('./services/notifications/settings');
const history = require('./services/agent/history');
const yc = require('./services/yclients-records');
const transport = require('./services/messaging/transport');
const dialogState = require('./services/agent/dialog-state');
const replies = require('./services/notifications/replies');

const REMINDER = 'Здравствуйте!\nНапоминаем о записи в «PERI CLINIC»\nВаша запись 14.10.2026 в 13:30\nПожалуйста, подтвердите визит';
const SURVEY = 'Спасибо что посетили «PERI CLINIC»! Просим Вас оценить обслуживание, отправив в ответ сообщение с цифрой от 2 до 5';
const msg = (text, over = {}) => ({ direction: 'incoming', channel: 'tdlib', phone: '79200255591', chatId: '123', type: 'text', text, ...over });
const salon = { id: 1, yclients_company_id: 5 };

function setup({ last, job, mode = 'live', escalate = true }) {
  settings.getSettings.mockResolvedValue({ mode, confirm_reply_text: '✅ Подтверждено',
    rating_high_text: 'Спасибо!', rating_mid_text: 'Что улучшить?', rating_low_text: 'Что не так?', rating_escalate_low: escalate });
  history.lastOutgoing.mockResolvedValue(last);
  db.oneOrNone.mockImplementation(async (sql) => (/FROM salons/.test(sql) ? salon : (/FROM notification_jobs/.test(sql) ? job : null)));
  db.query.mockResolvedValue({ rowCount: 1, rows: [] });
  yc.updateAttendance.mockResolvedValue({});
}
beforeEach(() => jest.clearAllMocks());

test('режим не live → не перехватываем', async () => {
  setup({ last: { author: 'system', text: REMINDER }, job: { id: 10, yclients_record_id: 100 }, mode: 'shadow' });
  expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: false });
});

test('подтверждение после нашего напоминания → attendance=2, отбивка, confirmed_at', async () => {
  setup({ last: { author: 'system', text: REMINDER }, job: { id: 10, yclients_record_id: 100, meta: { askConfirmation: true } } });
  const r = await replies.handleIncoming(1, msg('Здравствуйте, подтверждаю'));
  expect(r).toEqual({ handled: true, kind: 'confirmed' });
  expect(yc.updateAttendance).toHaveBeenCalledWith(salon, 100, 2);
  expect(transport.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ text: '✅ Подтверждено', phone: '79200255591', dispatchRouting: ['tdlib'] }));
  expect(db.query.mock.calls.some(([sql]) => /SET confirmed_at/.test(sql))).toBe(true);
});

test('последнее исходящее — не напоминание → Миле', async () => {
  setup({ last: { author: 'agent', text: 'Вас записать на 13:30?' }, job: null });
  expect(await replies.handleIncoming(1, msg('Да'))).toEqual({ handled: false });
});

test('не чистое подтверждение («да, а можно перенести?») → Миле', async () => {
  setup({ last: { author: 'system', text: REMINDER }, job: { id: 10, yclients_record_id: 100, meta: { askConfirmation: true } } });
  expect(await replies.handleIncoming(1, msg('Да, а можно перенести на 15:00?'))).toEqual({ handled: false });
  expect(yc.updateAttendance).not.toHaveBeenCalled();
});

test('YClients отказал → отбивки нет, ход Миле', async () => {
  setup({ last: { author: 'system', text: REMINDER }, job: { id: 10, yclients_record_id: 100, meta: { askConfirmation: true } } });
  yc.updateAttendance.mockRejectedValue(new Error('429'));
  expect(await replies.handleIncoming(1, msg('+'))).toEqual({ handled: false });
  expect(transport.sendMessage).not.toHaveBeenCalled();
});

test('«5» после нашего опроса → оценка сохранена, благодарность', async () => {
  setup({ last: { author: 'system', text: SURVEY }, job: { id: 11, yclients_record_id: 100, client_id: 9 } });
  expect(await replies.handleIncoming(1, msg('5'))).toEqual({ handled: true, kind: 'rating', rating: 5 });
  expect(db.query.mock.calls.some(([sql, p]) => /INSERT INTO visit_ratings/.test(sql) && p.includes(5))).toBe(true);
  expect(transport.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ text: 'Спасибо!' }));
  expect(dialogState.setStatus).not.toHaveBeenCalled();
});

test('«3» → текст «что не так» и перевод на администратора', async () => {
  setup({ last: { author: 'system', text: SURVEY }, job: { id: 11, yclients_record_id: 100, client_id: 9 } });
  expect(await replies.handleIncoming(1, msg('3'))).toEqual({ handled: true, kind: 'rating', rating: 3 });
  expect(transport.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ text: 'Что не так?' }));
  expect(dialogState.setStatus).toHaveBeenCalledWith(1, '79200255591', 'escalated', 'low_rating');
});

test('«4» → текст «что улучшить», без перевода на администратора', async () => {
  setup({ last: { author: 'system', text: SURVEY }, job: { id: 11, yclients_record_id: 100, client_id: 9 } });
  expect(await replies.handleIncoming(1, msg('4'))).toEqual({ handled: true, kind: 'rating', rating: 4 });
  expect(transport.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ text: 'Что улучшить?' }));
  expect(dialogState.setStatus).not.toHaveBeenCalled();
});

test('цифра со словами («5, спасибо!») → Миле', async () => {
  setup({ last: { author: 'system', text: SURVEY }, job: { id: 11, yclients_record_id: 100 } });
  expect(await replies.handleIncoming(1, msg('5, спасибо большое!'))).toEqual({ handled: false });
});

test('групповой чат и не-текст — не перехватываем', async () => {
  setup({ last: { author: 'system', text: SURVEY }, job: { id: 11, yclients_record_id: 100 } });
  expect(await replies.handleIncoming(1, msg('5', { chatType: 'group' }))).toEqual({ handled: false });
  expect(await replies.handleIncoming(1, msg('5', { type: 'messagePhoto' }))).toEqual({ handled: false });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest notifications-replies`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: `replies.js`**

```js
'use strict';
// ============================================================
// Ответы пациентов на НАШИ уведомления, без LLM, до Милы:
//  • чистое подтверждение после напоминания → YClients attendance=2 + отбивка;
//  • чистая цифра 2–5 после опроса → visit_ratings + текст по полосе (5 / 4 / 2–3),
//    2–3 → диалог на администратора, 4 → без перевода.
// Условие ДВУХЧАСТНОЕ (как в visit-rating.js): последнее исходящее диалога —
// авторства system и по тексту именно напоминание/опрос, И есть наш job этого
// типа по телефону. Иначе → { handled:false }, ход уходит Миле как раньше.
// Работает ТОЛЬКО в режиме live: в shadow/off отвечает Chatpush.
// ============================================================
const { db } = require('../../db');
const { createLogger } = require('../../logger');
const settingsSvc = require('./settings');
const history = require('../agent/history');
const { isPureConfirmation, isReminder } = require('../agent/visit-confirmation');
const { parseRating, isRatingSurvey } = require('../agent/visit-rating');
const { updateAttendance } = require('../yclients-records');
const transport = require('../messaging/transport');
const { recipientParams } = require('../chat');
const pendingReplies = require('../agent/pending-replies');
const authorship = require('../outgoing-authorship');
const { persistWhatsappOutgoing } = require('../chat-persist');
const dialogState = require('../agent/dialog-state');
const chatEvents = require('../chat-events');
const followupQueue = require('../agent/followup-queue');
const groupChat = require('../agent/group-chat');

const log = createLogger('NotifyReplies');
const TEXT_TYPES = new Set(['text', 'formattedText']);

function dialogKeyOf(msg) { return (msg.phone && msg.phone.trim()) || msg.chatId || null; }

async function lastJob(salonId, phone, type, hours) {
  if (!phone) return null;
  return db.oneOrNone(
    `SELECT id, yclients_record_id, client_id, meta FROM notification_jobs
      WHERE salon_id=$1 AND phone=$2 AND trigger_type=$3 AND status='sent'
        AND sent_at > NOW() - make_interval(hours => $4) AND confirmed_at IS NULL
      ORDER BY sent_at DESC LIMIT 1`,
    [salonId, phone, type, hours]);
}

async function sendSystem(salonId, msg, text) {
  const rp = recipientParams(msg.channel, { phone: msg.phone, chat_id: msg.chatId });
  if (!rp) throw new Error('нет адресата для ответа');
  const delivery = await transport.sendMessage(salonId, { ...rp, text, replyToMessageId: msg.messageId });
  const key = dialogKeyOf(msg);
  try { pendingReplies.remember(salonId, key, text); } catch (e) { log.error(`pending: ${e.message}`); }
  await authorship.remember(salonId, key, text, 'system').catch((e) => log.error(`authorship: ${e.message}`));
  if (msg.channel === 'whatsapp') {
    await persistWhatsappOutgoing(salonId, { delivery, phone: msg.phone, chatId: msg.chatId, text, msgType: 'text', authoredBy: 'system' })
      .catch((e) => log.error(`persist wa: ${e.message}`));
  }
  return delivery;
}

async function handleConfirmation(salonId, msg, cfg) {
  const job = await lastJob(salonId, msg.phone, 'visit_reminder', 48);
  if (!job || !(job.meta && job.meta.askConfirmation)) return { handled: false };
  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id = $1', [salonId]);
  if (!salon) return { handled: false };
  try {
    await updateAttendance(salon, Number(job.yclients_record_id), 2);
  } catch (e) {
    log.warn(`record ${job.yclients_record_id}: YClients не принял подтверждение (${e.message}) — ход Миле`);
    return { handled: false };
  }
  await db.query('UPDATE notification_jobs SET confirmed_at = NOW() WHERE id = $1', [job.id]);
  await sendSystem(salonId, msg, cfg.confirm_reply_text);
  log.info(`record ${job.yclients_record_id} подтверждён пациентом (${msg.channel})`);
  return { handled: true, kind: 'confirmed' };
}

async function handleRating(salonId, msg, rating, cfg) {
  const job = await lastJob(salonId, msg.phone, 'visit_review', 7 * 24);
  if (!job) return { handled: false };
  await db.query(
    `INSERT INTO visit_ratings (salon_id, yclients_record_id, client_id, phone, rating, source_job_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (salon_id, yclients_record_id) DO UPDATE SET rating=EXCLUDED.rating, created_at=NOW()`,
    [salonId, job.yclients_record_id, job.client_id || null, msg.phone, rating, job.id]);
  await db.query('UPDATE notification_jobs SET confirmed_at = NOW() WHERE id = $1', [job.id]);
  // Полосы утверждены владельцем 14.10.2026: 5 — благодарность (со ссылками на отзывы),
  // 4 — «что улучшить» без перевода, 2–3 — «что не устроило» и перевод на администратора.
  const low = rating <= 3;
  const text = rating === 5 ? cfg.rating_high_text : rating === 4 ? cfg.rating_mid_text : cfg.rating_low_text;
  await sendSystem(salonId, msg, text);
  if (low && cfg.rating_escalate_low) {
    const key = dialogKeyOf(msg);
    try {
      await dialogState.getOrCreate(salonId, key);
      await dialogState.setStatus(salonId, key, 'escalated', 'low_rating');
      chatEvents.emitAgentStatus(salonId, key, 'escalated', 'low_rating');
      await followupQueue.close(salonId, key, 'cancelled', 'operator').catch(() => {});
    } catch (e) { log.error(`escalate ${key}: ${e.message}`); }
  }
  log.info(`record ${job.yclients_record_id}: оценка ${rating}${low ? ' (низкая → администратор)' : ''}`);
  return { handled: true, kind: 'rating', rating };
}

/** msg — объект входящего из routes/chatpush-webhook.js. */
async function handleIncoming(salonId, msg) {
  try {
    if (!salonId || !msg || msg.direction !== 'incoming' || !TEXT_TYPES.has(msg.type)) return { handled: false };
    if (groupChat.isGroupMessage(msg)) return { handled: false };
    const text = String(msg.text || '').trim();
    if (!text || !msg.phone) return { handled: false };
    const cfg = await settingsSvc.getSettings(salonId);
    if (cfg.mode !== 'live') return { handled: false };
    const last = await history.lastOutgoing(salonId, dialogKeyOf(msg));
    if (!last || last.author !== 'system') return { handled: false };
    if (isReminder(last.text) && isPureConfirmation(text)) return handleConfirmation(salonId, msg, cfg);
    const rating = parseRating(text);
    if (rating != null && isRatingSurvey(last.text)) return handleRating(salonId, msg, rating, cfg);
    return { handled: false };
  } catch (e) {
    log.error(`handleIncoming: ${e.message}`);   // fail-open: ход уходит Миле
    return { handled: false };
  }
}

module.exports = { handleIncoming };
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd /root/loyalpro/backend && npx jest notifications-replies`
Expected: PASS, 10 тестов. Если `groupChat.isGroupMessage` ожидает другую форму (`chat_type`) — свериться с `services/agent/group-chat.js` и поправить вызов, не тест.

- [ ] **Step 5: Перехват в вебхуке** — в `routes/chatpush-webhook.js` добавить `const notifyReplies = require('../services/notifications/replies');` к импортам и заменить блок `if (config.CHATPUSH.agentEnabled && storedNew && …)` на:

```js
    // Ответ на НАШЕ уведомление («Подтверждаю» после напоминания, «5» после
    // опроса) обрабатывается детерминированно и Миле не достаётся: иначе два
    // ответа — наш и её. Внутри — только режим live, иначе {handled:false}.
    let notifyHandled = false;
    if (storedNew && msg && msg.direction === 'incoming' && salonId) {
      const r = await notifyReplies.handleIncoming(salonId, msg);
      notifyHandled = !!(r && r.handled);
      if (notifyHandled) logger.info(`notify reply: ${r.kind}${r.rating ? ' ' + r.rating : ''} — Мила не вызывается`);
    }

    if (
      !notifyHandled &&
      config.CHATPUSH.agentEnabled &&
      storedNew &&
      msg && msg.direction === 'incoming' &&
      AGENT_TEXT_TYPES.has(msg.type) && (msg.text || '').trim()
    ) {
```

(остальное тело `if` без изменений).

- [ ] **Step 6: Прогнать сьют вебхука**

Run: `cd /root/loyalpro/backend && npx jest chatpush-webhook-route notifications-replies`
Expected: PASS (в `chatpush-webhook-route.test.js` добавить `jest.mock('../services/notifications/replies', () => ({ handleIncoming: async () => ({ handled: false }) }))`, если сьют поднимает роутер без БД).

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro && git add backend/services/notifications/replies.js backend/routes/chatpush-webhook.js backend/notifications-replies.test.js backend/chatpush-webhook-route.test.js
git commit -m "feat(notifications): ответы на напоминание и опрос — статус «Подтвердил» в YClients и оценка визита без LLM

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: API — новые поля правил, настройки, журнал job'ов, вложение, тест, оценки, паритет

**Files:**
- Modify: `backend/routes/notification-rules.js` (весь файл; `parseRuleBody` остаётся экспортируемой чистой функцией)
- Test: `backend/notifications-routes.test.js`

- [ ] **Step 1: Падающий тест `parseRuleBody`**

```js
'use strict';
jest.mock('./db', () => ({ db: {} }));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn() }));
const { parseRuleBody, TRIGGER_TYPES } = require('./routes/notification-rules');

const ok = (over = {}) => ({ title: 'r', messageTemplate: 'Текст', channels: ['tdlib'], triggerType: 'record_created', ...over });

test('типы триггеров известны', () => {
  expect(TRIGGER_TYPES).toEqual(['record_created', 'record_rescheduled', 'record_cancelled', 'visit_reminder', 'visit_review', 'visit_after', 'first_visit']);
});
test('неизвестный trigger_type → ошибка', () => {
  expect(parseRuleBody(ok({ triggerType: 'birthday' })).error).toMatch(/тип/i);
});
test('visit_reminder: hours_before 1..72, дефолт 24', () => {
  expect(parseRuleBody(ok({ triggerType: 'visit_reminder' })).value.hoursBefore).toBe(24);
  expect(parseRuleBody(ok({ triggerType: 'visit_reminder', hoursBefore: 100 })).error).toMatch(/час/i);
});
test('visit_review/visit_after: delay_minutes 0..1440', () => {
  expect(parseRuleBody(ok({ triggerType: 'visit_review', delayMinutes: 5 })).value.delayMinutes).toBe(5);
  expect(parseRuleBody(ok({ triggerType: 'visit_after', delayMinutes: -1 })).error).toMatch(/минут/i);
});
test('неизвестный канал (в т.ч. sms) отбрасывается', () => {
  expect(parseRuleBody(ok({ channels: ['sms'] })).error).toMatch(/канал/i);
  expect(parseRuleBody(ok({ channels: ['tdlib', 'sms', 'max'] })).value.channels).toEqual(['tdlib', 'max']);
});
test('флаги нормализуются', () => {
  const v = parseRuleBody(ok({ onNoShow: false, askConfirmation: false })).value;
  expect(v).toMatchObject({ onNoShow: false, askConfirmation: false });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest notifications-routes`
Expected: FAIL — `TRIGGER_TYPES` undefined / `parseRuleBody` не экспортирована.

- [ ] **Step 3: Переписать `routes/notification-rules.js`**

Шапка и `parseRuleBody`:

```js
'use strict';
// /api/notification-rules — правила уведомлений YClients (owner/admin),
// настройки салона, журнал job'ов, вложение правила, тест на свой номер,
// оценки визитов, паритет с Chatpush (теневой режим).
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { auth, requireRole } = require('../middleware/auth');
const { db } = require('../db');
const { ycGet } = require('../services/yclients');
const { ALLOWED_CHANNELS } = require('../services/notifications/rules');
const settingsSvc = require('../services/notifications/settings');
const { imageFileFilter, validateImageBuffer } = require('../utils/upload-validator');
const { createLogger } = require('../logger');

const log = createLogger('NotificationRules');
const guard = [auth, requireRole('owner', 'admin')];
const TRIGGER_TYPES = ['record_created', 'record_rescheduled', 'record_cancelled', 'visit_reminder', 'visit_review', 'visit_after', 'first_visit'];
const JOB_STATUSES = ['pending', 'sent', 'shadow', 'skipped', 'cancelled', 'failed'];

const uploadsDir = path.join(__dirname, '../../frontend/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const attachUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: imageFileFilter });
function safeUnlink(relUrl) {
  if (!relUrl || !relUrl.startsWith('/uploads/')) return;
  fs.unlink(path.join(uploadsDir, path.basename(relUrl)), (err) => { if (err && err.code !== 'ENOENT') log.warn(`unlink: ${err.message}`); });
}

function intIn(v, min, max, dflt) {
  if (v == null || v === '') return dflt;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

// Валидация тела правила → { error } | { value } (значения нормализованы).
function parseRuleBody(body) {
  const b = body || {};
  const title = String(b.title || '').trim();
  if (!title) return { error: 'Название обязательно' };
  if (title.length > 255) return { error: 'Название слишком длинное' };
  const triggerType = String(b.triggerType || 'record_created');
  if (!TRIGGER_TYPES.includes(triggerType)) return { error: 'Неизвестный тип уведомления' };

  const template = String(b.messageTemplate || '').trim();
  if (!template) return { error: 'Текст сообщения пуст' };
  if (template.length > 4000) return { error: 'Сообщение слишком длинное (макс 4000 символов)' };

  const c = b.conditions || {};
  const logic = c.logic === 'or' ? 'or' : 'and';
  const items = [];
  for (const it of (Array.isArray(c.items) ? c.items : [])) {
    if (!it || !['staff', 'category', 'service'].includes(it.type)) return { error: 'Неизвестный тип условия' };
    const ids = (Array.isArray(it.ids) ? it.ids : []).map((v) => parseInt(v, 10)).filter(Number.isFinite);
    if (ids.length) items.push({ type: it.type, ids });
  }

  const channels = (Array.isArray(b.channels) ? b.channels : []).filter((ch) => ALLOWED_CHANNELS.includes(ch));
  if (!channels.length) return { error: 'Выберите хотя бы один канал отправки' };

  const hoursBefore = triggerType === 'visit_reminder' ? intIn(b.hoursBefore, 1, 72, 24) : null;
  if (triggerType === 'visit_reminder' && hoursBefore == null) return { error: 'Часы до визита: число от 1 до 72' };
  const delayMinutes = (triggerType === 'visit_review' || triggerType === 'visit_after') ? intIn(b.delayMinutes, 0, 1440, 5) : null;
  if ((triggerType === 'visit_review' || triggerType === 'visit_after') && delayMinutes == null) return { error: 'Минут после визита: число от 0 до 1440' };

  return {
    value: {
      title, triggerType, messageTemplate: template, conditions: { logic, items }, channels,
      preferLastChannel: b.preferLastChannel !== false, isEnabled: b.isEnabled !== false,
      hoursBefore, delayMinutes,
      onNoShow: b.onNoShow !== false,
      askConfirmation: b.askConfirmation !== false,
    },
  };
}
```

Маршруты правил (`GET /`, `POST /`, `PUT /:id`, `POST /:id/toggle`, `DELETE /:id`) — как в v1, но INSERT/UPDATE пишут новые колонки:

```js
const RULE_COLS = `title, is_enabled, trigger_type, conditions, message_template, channels, prefer_last_channel,
  hours_before, delay_minutes, on_no_show, ask_confirmation`;
function ruleParams(v) {
  return [v.title, v.isEnabled, v.triggerType, JSON.stringify(v.conditions), v.messageTemplate, JSON.stringify(v.channels),
    v.preferLastChannel, v.hoursBefore, v.delayMinutes, v.onNoShow, v.askConfirmation];
}

router.get('/', guard, async (req, res) => {
  try {
    const rules = await db.any(
      `SELECT r.*,
              (SELECT count(*) FROM notification_jobs j WHERE j.rule_id = r.id AND j.status = 'sent') AS sent_count,
              (SELECT count(*) FROM notification_jobs j WHERE j.rule_id = r.id AND j.status = 'failed') AS failed_count,
              (SELECT count(*) FROM notification_jobs j WHERE j.rule_id = r.id AND j.status = 'pending') AS pending_count,
              (SELECT count(*) FROM notification_jobs j WHERE j.rule_id = r.id AND j.status = 'shadow') AS shadow_count
         FROM notification_rules r WHERE r.salon_id = $1 ORDER BY r.trigger_type, r.id`,
      [req.user.salonId]);
    res.json({ rules, triggerTypes: TRIGGER_TYPES });
  } catch (e) { log.error(`list: ${e.message}`); res.status(500).json({ error: e.message }); }
});

router.post('/', guard, async (req, res) => {
  try {
    const { error, value } = parseRuleBody(req.body);
    if (error) return res.status(400).json({ error });
    const rule = await db.one(
      `INSERT INTO notification_rules (salon_id, ${RULE_COLS}, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [req.user.salonId, ...ruleParams(value), req.user.id]);
    res.json({ ok: true, rule });
  } catch (e) { log.error(`create: ${e.message}`); res.status(500).json({ error: e.message }); }
});

router.put('/:id', guard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const { error, value } = parseRuleBody(req.body);
    if (error) return res.status(400).json({ error });
    const rule = await db.oneOrNone(
      `UPDATE notification_rules SET title=$3, is_enabled=$4, trigger_type=$5, conditions=$6::jsonb, message_template=$7,
          channels=$8::jsonb, prefer_last_channel=$9, hours_before=$10, delay_minutes=$11,
          on_no_show=$12, ask_confirmation=$13, updated_at=NOW()
        WHERE id=$1 AND salon_id=$2 RETURNING *`,
      [id, req.user.salonId, ...ruleParams(value)]);
    if (!rule) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, rule });
  } catch (e) { log.error(`update: ${e.message}`); res.status(500).json({ error: e.message }); }
});
```

(`GET /dictionaries`, `POST /:id/toggle`, `DELETE /:id` — перенести из v1 как есть; `DELETE` дополнительно зовёт `safeUnlink(rule.attachment_url)`. Маршрут `GET /:id/sends` заменить на `GET /:id/jobs`, читающий `notification_jobs` теми же колонками плюс `trigger_type, scheduled_at, decision_reason, confirmed_at`.)

Новые маршруты (вставить ПЕРЕД `/:id`-маршрутами — `/settings`, `/jobs`, `/ratings`, `/parity` иначе матчатся как `:id`):

```js
// ── настройки салона ──
router.get('/settings', guard, async (req, res) => {
  try { res.json(await settingsSvc.getSettings(req.user.salonId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/settings', guard, async (req, res) => {
  try { res.json(await settingsSvc.updateSettings(req.user.salonId, req.body || {})); }
  catch (e) {
    if (e.code === 'BAD_TIME') return res.status(400).json({ error: 'Тихие часы: формат ЧЧ:ММ' });
    res.status(500).json({ error: e.message });
  }
});

// ── журнал job'ов: ?type=&status=&date=YYYY-MM-DD&page= ──
router.get('/jobs', guard, async (req, res) => {
  try {
    const type = TRIGGER_TYPES.includes(req.query.type) ? req.query.type : null;
    const status = JOB_STATUSES.includes(req.query.status) ? req.query.status : null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : null;
    const page = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
    const items = await db.any(
      `SELECT j.id, j.rule_id, j.rule_title, j.trigger_type, j.yclients_record_id, j.visit_datetime, j.phone, j.status,
              j.attempts, j.error, j.rendered_text, j.attachment_url, j.routing, j.channel_used, j.delivery_id,
              j.scheduled_at, j.sent_at, j.created_at, j.confirmed_at, j.decision_reason, c.name AS client_name
         FROM notification_jobs j LEFT JOIN clients c ON c.id = j.client_id
        WHERE j.salon_id = $1
          AND ($2::text IS NULL OR j.trigger_type = $2)
          AND ($3::text IS NULL OR j.status = $3)
          AND ($4::date IS NULL OR (j.scheduled_at AT TIME ZONE 'Europe/Moscow')::date = $4::date)
        ORDER BY CASE WHEN j.status = 'pending' THEN j.scheduled_at END ASC, j.id DESC
        LIMIT 100 OFFSET $5`,
      [req.user.salonId, type, status, date, page * 100]);
    res.json({ items, page });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/jobs/:id/cancel', guard, async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE notification_jobs SET status='cancelled', decision_reason='отменено администратором'
        WHERE id=$1 AND salon_id=$2 AND status='pending'`, [parseInt(req.params.id, 10) || 0, req.user.salonId]);
    res.json({ ok: !!r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── оценки визитов ──
router.get('/ratings', guard, async (req, res) => {
  try {
    const items = await db.any(
      `SELECT v.id, v.yclients_record_id, v.phone, v.rating, v.comment, v.created_at, c.name AS client_name
         FROM visit_ratings v LEFT JOIN clients c ON c.id = v.client_id
        WHERE v.salon_id = $1 ORDER BY v.created_at DESC LIMIT 500`, [req.user.salonId]);
    const stats = await db.oneOrNone(
      `SELECT count(*)::int AS n, round(avg(rating)::numeric, 2) AS avg,
              count(*) FILTER (WHERE rating >= 4)::int AS high, count(*) FILTER (WHERE rating < 4)::int AS low
         FROM visit_ratings WHERE salon_id = $1 AND created_at > NOW() - interval '30 days'`, [req.user.salonId]);
    res.json({ items, stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── паритет с Chatpush: наши job'ы против служебных исходящих Chatpush по типу ──
const PARITY_PATTERNS = {
  record_created: 'Вы записаны на прием%', visit_reminder: '%Напоминаем о записи%', record_rescheduled: '%перенесена%',
  record_cancelled: '%отменена%', visit_review: 'Спасибо что посетили%', visit_after: 'Рекомендации после%', first_visit: 'Присоединяйтесь к программе%',
};
router.get('/parity', guard, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '7', 10) || 7, 1), 60);
    const out = [];
    for (const t of TRIGGER_TYPES) {
      const ours = await db.oneOrNone(
        `SELECT count(*) FILTER (WHERE status IN ('sent','shadow'))::int AS planned,
                count(*) FILTER (WHERE status='skipped')::int AS skipped, count(*) FILTER (WHERE status='cancelled')::int AS cancelled
           FROM notification_jobs WHERE salon_id=$1 AND trigger_type=$2 AND created_at > NOW() - make_interval(days => $3)`,
        [req.user.salonId, t, days]);
      const theirs = await db.oneOrNone(
        `SELECT count(*)::int AS n FROM chatpush_messages
          WHERE salon_id=$1 AND direction='outgoing' AND authored_by='system' AND text LIKE $2
            AND msg_ts > extract(epoch from NOW() - make_interval(days => $3))`,
        [req.user.salonId, PARITY_PATTERNS[t], days]);
      out.push({ triggerType: t, ours: ours || { planned: 0, skipped: 0, cancelled: 0 }, chatpush: theirs ? theirs.n : 0 });
    }
    res.json({ days, items: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── вложение правила (visit_after): multipart file ──
router.post('/:id/attachment', guard, (req, res) => {
  attachUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой: лимит 5 МБ' : err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран или формат не поддерживается (JPEG, PNG, WEBP)' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const valid = validateImageBuffer(req.file.buffer, req.file.originalname);
    if (!valid.ok) return res.status(400).json({ error: valid.error });
    const ext = (req.file.originalname.match(/\.[A-Za-z0-9]+$/) || ['.jpg'])[0].toLowerCase();
    const fileName = `notify_${req.user.salonId}_${id}_${Date.now()}${ext}`;
    const fileUrl = `/uploads/${fileName}`;
    try {
      const old = await db.oneOrNone('SELECT attachment_url FROM notification_rules WHERE id=$1 AND salon_id=$2', [id, req.user.salonId]);
      if (!old) return res.status(404).json({ error: 'not found' });
      fs.writeFileSync(path.join(uploadsDir, fileName), req.file.buffer);
      await db.query('UPDATE notification_rules SET attachment_url=$3, attachment_name=$4, updated_at=NOW() WHERE id=$1 AND salon_id=$2',
        [id, req.user.salonId, fileUrl, req.file.originalname.slice(0, 255)]);
      safeUnlink(old.attachment_url);
      res.json({ ok: true, attachmentUrl: fileUrl });
    } catch (e) { safeUnlink(fileUrl); res.status(500).json({ error: e.message }); }
  });
});
router.delete('/:id/attachment', guard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const old = await db.oneOrNone('SELECT attachment_url FROM notification_rules WHERE id=$1 AND salon_id=$2', [id, req.user.salonId]);
    if (!old) return res.status(404).json({ error: 'not found' });
    await db.query('UPDATE notification_rules SET attachment_url=NULL, attachment_name=NULL, updated_at=NOW() WHERE id=$1 AND salon_id=$2', [id, req.user.salonId]);
    safeUnlink(old.attachment_url);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── тест на свой номер: job «сейчас», тем же воркером; перепроверку состояния
//    пропускает meta.test; в режиме shadow/off строка ляжет shadow/останется pending —
//    ответ ручки это говорит явно ──
router.post('/:id/test', guard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const phone = String((req.body || {}).phone || '').replace(/\D/g, '').replace(/^8/, '7');
    if (!/^7\d{10}$/.test(phone)) return res.status(400).json({ error: 'Номер: 11 цифр, начиная с 7' });
    const rule = await db.oneOrNone('SELECT * FROM notification_rules WHERE id=$1 AND salon_id=$2', [id, req.user.salonId]);
    if (!rule) return res.status(404).json({ error: 'not found' });
    const cfg = await settingsSvc.getSettings(req.user.salonId);
    const { renderTemplate } = require('../services/notifications/render');
    const text = renderTemplate(rule.message_template, { name: 'Тест Тестовна', date: '31.12.2026', time: '12:00', end_time: '13:00',
      services: 'Тестовая услуга', staff: 'Мастер', salon: 'Салон', record_link: 'https://example.com', rating_links: '' });
    const row = await db.one(
      `INSERT INTO notification_jobs (salon_id, rule_id, rule_title, trigger_type, yclients_record_id, visit_datetime, phone, scheduled_at,
          rendered_text, attachment_url, meta, decision_reason)
       VALUES ($1,$2,$3,$4,0,NULL,$5,NOW(),$6,$7,'{"test":true}'::jsonb,'тестовая отправка') RETURNING id`,
      [req.user.salonId, rule.id, rule.title, rule.trigger_type, phone, text, rule.attachment_url]);
    res.json({ ok: true, jobId: row.id, mode: cfg.mode,
      note: cfg.mode === 'live' ? 'уйдёт в течение 10 с' : `режим «${cfg.mode}»: строка попадёт в журнал без отправки` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.parseRuleBody = parseRuleBody;
module.exports.TRIGGER_TYPES = TRIGGER_TYPES;
```

ГОТЧА уникального индекса для тестов: `(rule_id, 0, 'epoch')` — второй тест того же правила упрётся в `DO NOTHING`/ошибку дубля. В INSERT теста добавить `ON CONFLICT (rule_id, yclients_record_id, COALESCE(visit_datetime, 'epoch'::timestamptz)) DO UPDATE SET status='pending', scheduled_at=NOW(), phone=EXCLUDED.phone, rendered_text=EXCLUDED.rendered_text, attempts=0, error=NULL, sent_at=NULL RETURNING id`.

- [ ] **Step 4: Тесты**

Run: `cd /root/loyalpro/backend && npx jest notifications-routes`
Expected: PASS, 6 тестов.

- [ ] **Step 5: Живая проверка ручек на деве** (токен — из `sessions`, см. `dev_db_access_tunnel`):

```bash
T=<jwt>; H="Authorization: Bearer $T"; B=http://localhost:3001/api/notification-rules
curl -s -H "$H" $B/settings | head -c 300; echo
curl -s -H "$H" -X PUT $B/settings -H 'Content-Type: application/json' -d '{"mode":"shadow"}' | head -c 200; echo
curl -s -H "$H" -X POST $B -H 'Content-Type: application/json' -d '{"title":"Напоминание","triggerType":"visit_reminder","hoursBefore":24,"messageTemplate":"Напоминаем о записи {date} в {time}. Пожалуйста, подтвердите визит","channels":["tdlib","whatsapp"]}'; echo
curl -s -H "$H" "$B/jobs?status=shadow" | head -c 300; echo
curl -s -H "$H" "$B/parity?days=7"; echo
```
Expected: 200 на всех, у `parity` семь строк с `chatpush > 0` у типов, которые Chatpush реально шлёт.

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add backend/routes/notification-rules.js backend/notifications-routes.test.js
git commit -m "feat(notifications): API — типы правил, настройки салона, журнал job'ов, вложения, тест, оценки, паритет

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Фронт — вкладка «Уведомления» (правила по типам, настройки, журнал, оценки)

**Files:**
- Create: `frontend/js/pages/notifications.js`
- Modify: `frontend/index.html:1110-1125` (разметка вкладки), `frontend/index.html:2559` (`broadcast-rules.js` → `notifications.js?v=2026-10-13a`)
- `frontend/js/pages/broadcast-rules.js` — из `index.html` снять (файл остаётся до следующей чистки); `bcSwitchTab` переезжает в `notifications.js`

Зависимости в глобальной области (как у соседей): `api(path, opts)` из `core/api.js`, `esc(s)`, `notify(text)`, `condRender/condGet/condSet` из `conditions-editor.js` (ns `'ntf'`). ГОТЧА: все page-скрипты делят одну глобальную область — верхнеуровневый `const` с именем уже объявленной функции ломает весь файл (инцидент с `chat-wait-status.js`); все имена здесь с префиксом `nt`.

- [ ] **Step 1: Разметка** — в `index.html` заменить содержимое `<div id="bcTab-rules">` (всё, что было у v1) на:

```html
      <div id="bcTab-rules" style="display:none">
        <div class="bc-head">
          <div>
            <div class="bc-head-title">🔁 Уведомления клиентам по записям YClients</div>
            <div class="bc-head-sub" id="ntModeLine">Режим: —</div>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn" onclick="ntOpenSettings()">⚙️ Настройки</button>
            <button class="btn btn-pri" onclick="ntOpenEditor(null)">+ Правило</button>
          </div>
        </div>
        <div class="tabs" style="max-width:520px;margin-top:10px">
          <button class="tab active" id="ntSubBtn-rules" onclick="ntSub('rules')">Правила</button>
          <button class="tab" id="ntSubBtn-jobs" onclick="ntSub('jobs')">Журнал</button>
          <button class="tab" id="ntSubBtn-ratings" onclick="ntSub('ratings')">Оценки</button>
          <button class="tab" id="ntSubBtn-parity" onclick="ntSub('parity')">Сверка с Chatpush</button>
        </div>
        <div id="ntSub-rules"></div>
        <div id="ntSub-jobs" style="display:none">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">
            <select id="ntJobType" onchange="ntLoadJobs()"><option value="">Все типы</option></select>
            <select id="ntJobStatus" onchange="ntLoadJobs()">
              <option value="">Все статусы</option><option value="pending">В очереди</option><option value="sent">Отправлено</option>
              <option value="shadow">Тень</option><option value="skipped">Пропущено</option><option value="cancelled">Отменено</option><option value="failed">Ошибка</option>
            </select>
            <input type="date" id="ntJobDate" onchange="ntLoadJobs()">
          </div>
          <div id="ntJobsList"></div>
        </div>
        <div id="ntSub-ratings" style="display:none"></div>
        <div id="ntSub-parity" style="display:none"></div>
      </div>
```

Модалки (в конец `page-broadcasts`): `ntEditor` (поля: название, тип `<select id="ntType">`, блок `ntTypeFields` (часы до / минуты после / вложение / флаги), условия `<div id="ntConds"></div>`, текст `<textarea id="ntText">` с кнопками переменных, каналы `<div id="ntChannels"></div>` + чекбокс `prefer_last_channel`, кнопки «Сохранить», «🧪 Тест», «Удалить») и `ntSettings` (режим, каналы по умолчанию, тихие часы `ntsQuietFrom`/`ntsQuietTo`, текст подтверждения `ntsConfirm`, тексты оценок `ntsHigh` (5) / `ntsMid` (4) / `ntsLow` (2–3), чекбокс перевода на администратора при 2–3 `ntsEscalate`). Разметка модалок — по образцу `nrEditor` v1 (классы `modal`, `fg`/`fl`, `btn-pri`).

- [ ] **Step 2: `notifications.js`** (ключевые функции; остальное — по образцу `broadcast-rules.js`):

```js
// ── УВЕДОМЛЕНИЯ ПО ЗАПИСЯМ YCLIENTS (вкладка на странице «Рассылки») ──
// Правила по типам + настройки салона + журнал job'ов + оценки + сверка с Chatpush.
// Зависимости: api(), esc(), notify(), condRender/condGet/condSet (conditions-editor.js, ns 'ntf').
const NT_TYPES = {
  record_created:    { lbl: 'Запись создана',          hint: 'Сразу после создания записи' },
  record_rescheduled:{ lbl: 'Запись перенесена',       hint: 'Когда изменилось время визита' },
  record_cancelled:  { lbl: 'Запись отменена',         hint: 'Удаление записи или статус «не пришёл»' },
  visit_reminder:    { lbl: 'Напоминание о визите',    hint: 'За N часов до визита; просит подтвердить' },
  visit_review:      { lbl: 'Опрос после визита',      hint: 'Через N минут после окончания; ответ цифрой 2–5' },
  visit_after:       { lbl: 'Рекомендации после процедуры', hint: 'По услугам, с картинкой' },
  first_visit:       { lbl: 'Первый визит',            hint: 'Приглашение в программу лояльности' },
};
const NT_CH = { tdlib: 'Telegram (номер)', whatsapp: 'WhatsApp', max: 'MAX', telegram: 'Telegram (бот)', max_bot: 'MAX (бот)', notify: 'ВК/ОК' };
const NT_ST = { pending: ['В очереди', '#9ca3af'], sent: ['Отправлено', '#10b981'], shadow: ['Тень', '#6366f1'],
  skipped: ['Пропущено', '#f59e0b'], cancelled: ['Отменено', '#9ca3af'], failed: ['Ошибка', '#ef4444'] };
let _ntRules = [], _ntSettings = null, _ntDicts = null, _ntEditId = null, _ntChannels = [], _ntLoaded = false;

function bcSwitchTab(tab) {
  document.getElementById('bcTab-once').style.display  = tab === 'once'  ? '' : 'none';
  document.getElementById('bcTab-rules').style.display = tab === 'rules' ? '' : 'none';
  document.getElementById('bcTabBtn-once').classList.toggle('active', tab === 'once');
  document.getElementById('bcTabBtn-rules').classList.toggle('active', tab === 'rules');
  if (tab === 'rules' && !_ntLoaded) ntLoad();
}
function ntSub(name) {
  for (const n of ['rules', 'jobs', 'ratings', 'parity']) {
    document.getElementById('ntSub-' + n).style.display = n === name ? '' : 'none';
    document.getElementById('ntSubBtn-' + n).classList.toggle('active', n === name);
  }
  if (name === 'jobs') ntLoadJobs(); if (name === 'ratings') ntLoadRatings(); if (name === 'parity') ntLoadParity();
}
async function ntLoad() {
  _ntLoaded = true;
  const [r, s, d] = await Promise.all([api('/notification-rules'), api('/notification-rules/settings'), _ntDicts ? Promise.resolve(_ntDicts) : api('/notification-rules/dictionaries')]);
  _ntRules = r.rules || []; _ntSettings = s; _ntDicts = d;
  const sel = document.getElementById('ntJobType');
  sel.innerHTML = '<option value="">Все типы</option>' + Object.entries(NT_TYPES).map(([k, v]) => `<option value="${k}">${esc(v.lbl)}</option>`).join('');
  ntRenderMode(); ntRenderRules();
}
function ntRenderMode() {
  const m = _ntSettings.mode;
  const txt = m === 'live' ? '🟢 боевой — уведомления уходят клиентам' : m === 'shadow' ? '🟡 теневой — строки пишутся в журнал, отправки нет' : '⚪ выключен';
  document.getElementById('ntModeLine').textContent = 'Режим: ' + txt;
}
function ntRenderRules() {
  const byType = {};
  for (const r of _ntRules) (byType[r.trigger_type] = byType[r.trigger_type] || []).push(r);
  document.getElementById('ntSub-rules').innerHTML = Object.entries(NT_TYPES).map(([t, meta]) => `
    <div class="card" style="margin-top:10px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><b>${esc(meta.lbl)}</b><div class="muted" style="font-size:12px">${esc(meta.hint)}</div></div>
        <button class="btn" onclick="ntOpenEditor(null,'${t}')">+ Правило</button>
      </div>
      ${(byType[t] || []).map(r => `
        <div class="nt-rule" style="display:flex;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--line)">
          <label class="switch"><input type="checkbox" ${r.is_enabled ? 'checked' : ''} onchange="ntToggle(${r.id})"><span></span></label>
          <div style="flex:1;cursor:pointer" onclick="ntOpenEditor(${r.id})">
            <div>${esc(r.title)} ${r.attachment_url ? '📎' : ''}</div>
            <div class="muted" style="font-size:12px">${esc(ntRuleSummary(r))} · каналы: ${(r.channels || []).map(c => NT_CH[c] || c).join(' → ')}</div>
          </div>
          <div class="muted" style="font-size:12px">✅ ${r.sent_count} · 🟡 ${r.shadow_count} · ⏳ ${r.pending_count} · ❌ ${r.failed_count}</div>
        </div>`).join('') || '<div class="muted" style="padding:8px 0;font-size:12px">Правил нет</div>'}
    </div>`).join('');
}
function ntRuleSummary(r) {
  const parts = [];
  if (r.trigger_type === 'visit_reminder') parts.push(`за ${r.hours_before || 24} ч${r.ask_confirmation ? ', с подтверждением' : ''}`);
  if (r.trigger_type === 'visit_review' || r.trigger_type === 'visit_after') parts.push(`через ${r.delay_minutes ?? 5} мин после визита`);
  if (r.trigger_type === 'record_cancelled') parts.push(r.on_no_show ? 'и при «не пришёл»' : 'без «не пришёл»');
  const items = (r.conditions && r.conditions.items) || [];
  parts.push(items.length ? `условий: ${items.length} (${r.conditions.logic === 'or' ? 'ИЛИ' : 'И'})` : 'любая запись');
  return parts.join(' · ');
}
async function ntToggle(id) { await api(`/notification-rules/${id}/toggle`, { method: 'POST' }); await ntLoad(); }

function ntOpenEditor(id, type) {
  _ntEditId = id;
  const r = id ? _ntRules.find(x => x.id === id) : { trigger_type: type || 'record_created', channels: _ntSettings.default_channels, conditions: { logic: 'and', items: [] },
    message_template: '', prefer_last_channel: true, hours_before: 24, delay_minutes: 5, on_no_show: true, ask_confirmation: true };
  document.getElementById('ntTitle').value = r.title || '';
  document.getElementById('ntType').value = r.trigger_type;
  document.getElementById('ntText').value = r.message_template || '';
  document.getElementById('ntPreferLast').checked = r.prefer_last_channel !== false;
  _ntChannels = [...(r.channels || [])];
  ntRenderTypeFields(r); ntRenderChannels();
  condSet('ntf', r.conditions, _ntDicts); condRender('ntf', 'ntConds');
  document.getElementById('ntTestBtn').style.display = id ? '' : 'none';
  document.getElementById('ntDeleteBtn').style.display = id ? '' : 'none';
  document.getElementById('ntEditor').classList.add('open');
}
function ntRenderTypeFields(r) {
  const t = document.getElementById('ntType').value;
  const box = document.getElementById('ntTypeFields');
  let html = '';
  if (t === 'visit_reminder') html += `<div class="fg"><label class="fl">За сколько часов до визита</label><input type="number" id="ntHours" min="1" max="72" value="${r.hours_before || 24}"></div>
    <label><input type="checkbox" id="ntAsk" ${r.ask_confirmation !== false ? 'checked' : ''}> Просить подтверждение (ответ «Подтверждаю»/«+» ставит статус «Подтвердил» в YClients)</label>`;
  if (t === 'visit_review' || t === 'visit_after') html += `<div class="fg"><label class="fl">Через сколько минут после окончания визита</label><input type="number" id="ntDelay" min="0" max="1440" value="${r.delay_minutes ?? 5}"></div>`;
  if (t === 'visit_after') html += `<div class="fg"><label class="fl">Картинка (JPEG/PNG/WEBP, до 5 МБ)</label>
    ${r.attachment_url ? `<div><img src="${esc(r.attachment_url)}" style="max-height:120px;border-radius:8px"> <button class="btn" onclick="ntDeleteAttachment()">Убрать</button></div>` : ''}
    <input type="file" id="ntFile" accept="image/*" ${_ntEditId ? '' : 'disabled title="Сначала сохраните правило"'}></div>`;
  if (t === 'record_cancelled') html += `<label><input type="checkbox" id="ntNoShow" ${r.on_no_show !== false ? 'checked' : ''}> Слать и при статусе «клиент не пришёл»</label>`;
  box.innerHTML = html;
}
function ntRenderChannels() {
  document.getElementById('ntChannels').innerHTML = Object.entries(NT_CH).map(([c, l]) => {
    const i = _ntChannels.indexOf(c);
    return `<span class="chip ${i >= 0 ? 'on' : ''}" onclick="ntToggleChannel('${c}')">${i >= 0 ? (i + 1) + '. ' : ''}${esc(l)}</span>`;
  }).join(' ');
}
function ntToggleChannel(c) { const i = _ntChannels.indexOf(c); if (i >= 0) _ntChannels.splice(i, 1); else _ntChannels.push(c); ntRenderChannels(); }
function ntInsertVar(tok) { const ta = document.getElementById('ntText'); const s = ta.selectionStart; ta.value = ta.value.slice(0, s) + tok + ta.value.slice(ta.selectionEnd); ta.focus(); }

async function ntSave() {
  const t = document.getElementById('ntType').value;
  const g = (id) => document.getElementById(id);
  const body = { title: g('ntTitle').value, triggerType: t, messageTemplate: g('ntText').value,
    conditions: condGet('ntf'), channels: _ntChannels, preferLastChannel: g('ntPreferLast').checked,
    hoursBefore: g('ntHours') ? Number(g('ntHours').value) : undefined, delayMinutes: g('ntDelay') ? Number(g('ntDelay').value) : undefined,
    askConfirmation: g('ntAsk') ? g('ntAsk').checked : true, onNoShow: g('ntNoShow') ? g('ntNoShow').checked : true };
  try {
    const res = _ntEditId ? await api(`/notification-rules/${_ntEditId}`, { method: 'PUT', body })
      : await api('/notification-rules', { method: 'POST', body });
    const file = g('ntFile') && g('ntFile').files[0];
    if (file) { const fd = new FormData(); fd.append('file', file); await api(`/notification-rules/${res.rule.id}/attachment`, { method: 'POST', body: fd, raw: true }); }
    notify('Сохранено'); ntCloseEditor(); await ntLoad();
  } catch (e) { notify(e.message || 'Ошибка', 'error'); }
}
async function ntDeleteAttachment() { await api(`/notification-rules/${_ntEditId}/attachment`, { method: 'DELETE' }); await ntLoad(); ntOpenEditor(_ntEditId); }
async function ntTest() {
  const phone = prompt('Номер для тестовой отправки (79…):');
  if (!phone) return;
  try { const r = await api(`/notification-rules/${_ntEditId}/test`, { method: 'POST', body: { phone } }); notify(r.note); }
  catch (e) { notify(e.message, 'error'); }
}
async function ntDelete() { if (!confirm('Удалить правило?')) return; await api(`/notification-rules/${_ntEditId}`, { method: 'DELETE' }); ntCloseEditor(); await ntLoad(); }
function ntCloseEditor() { document.getElementById('ntEditor').classList.remove('open'); }

async function ntLoadJobs() {
  const q = new URLSearchParams({ type: document.getElementById('ntJobType').value, status: document.getElementById('ntJobStatus').value, date: document.getElementById('ntJobDate').value });
  const { items } = await api('/notification-rules/jobs?' + q);
  document.getElementById('ntJobsList').innerHTML = items.length ? `<table class="tbl"><thead><tr><th>Когда</th><th>Тип</th><th>Клиент</th><th>Статус</th><th>Текст</th></tr></thead><tbody>` +
    items.map(j => `<tr><td>${esc(ntFmt(j.status === 'pending' ? j.scheduled_at : (j.sent_at || j.created_at)))}</td><td>${esc((NT_TYPES[j.trigger_type] || {}).lbl || j.trigger_type)}</td>
      <td>${esc(j.client_name || '')}<div class="muted">${esc(j.phone || '')}</div></td>
      <td><span style="color:${NT_ST[j.status][1]}">${NT_ST[j.status][0]}</span>${j.channel_used ? ' · ' + esc(j.channel_used) : ''}${j.confirmed_at ? ' · ✅ ответ' : ''}<div class="muted" style="font-size:11px">${esc(j.decision_reason || j.error || '')}</div>
        ${j.status === 'pending' ? `<button class="btn btn-xs" onclick="ntCancelJob(${j.id})">Отменить</button>` : ''}</td>
      <td style="white-space:pre-wrap;max-width:420px;font-size:12px">${esc(j.rendered_text)}${j.attachment_url ? ' 📎' : ''}</td></tr>`).join('') + '</tbody></table>'
    : '<div class="muted">Пусто</div>';
}
async function ntCancelJob(id) { await api(`/notification-rules/jobs/${id}/cancel`, { method: 'POST' }); ntLoadJobs(); }
function ntFmt(ts) { return ts ? new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''; }

async function ntLoadRatings() {
  const { items, stats } = await api('/notification-rules/ratings');
  document.getElementById('ntSub-ratings').innerHTML = `<div class="card" style="margin-top:10px">За 30 дней: ${stats ? `${stats.n} оценок, средняя ${stats.avg ?? '—'}, высоких ${stats.high}, низких ${stats.low}` : '—'}</div>` +
    (items.length ? `<table class="tbl"><thead><tr><th>Дата</th><th>Клиент</th><th>Оценка</th></tr></thead><tbody>` +
      items.map(v => `<tr><td>${esc(ntFmt(v.created_at))}</td><td>${esc(v.client_name || '')}<div class="muted">${esc(v.phone || '')}</div></td><td style="color:${v.rating >= 4 ? '#10b981' : '#ef4444'}"><b>${v.rating}</b></td></tr>`).join('') + '</tbody></table>' : '<div class="muted">Оценок нет</div>');
}
async function ntLoadParity() {
  const { days, items } = await api('/notification-rules/parity?days=7');
  document.getElementById('ntSub-parity').innerHTML = `<div class="muted" style="margin:10px 0">За ${days} дн.: наши job'ы (отправлено+тень) против служебных сообщений Chatpush того же типа. Разница в единицы — норма (ЧС, нет телефона, разный момент «пришёл»).</div>
    <table class="tbl"><thead><tr><th>Тип</th><th>Мы (план)</th><th>Пропущено</th><th>Отменено</th><th>Chatpush</th></tr></thead><tbody>` +
    items.map(i => `<tr><td>${esc(NT_TYPES[i.triggerType].lbl)}</td><td>${i.ours.planned}</td><td>${i.ours.skipped}</td><td>${i.ours.cancelled}</td><td>${i.chatpush}</td></tr>`).join('') + '</tbody></table>';
}

function ntOpenSettings() {
  const s = _ntSettings; const g = (id) => document.getElementById(id);
  g('ntsMode').value = s.mode; g('ntsQuietFrom').value = s.quiet_from || ''; g('ntsQuietTo').value = s.quiet_to || '';
  g('ntsConfirm').value = s.confirm_reply_text; g('ntsHigh').value = s.rating_high_text; g('ntsMid').value = s.rating_mid_text; g('ntsLow').value = s.rating_low_text;
  g('ntsEscalate').checked = !!s.rating_escalate_low;
  g('ntSettings').classList.add('open');
}
async function ntSaveSettings() {
  const g = (id) => document.getElementById(id);
  const body = { mode: g('ntsMode').value, quiet_from: g('ntsQuietFrom').value || null, quiet_to: g('ntsQuietTo').value || null,
    confirm_reply_text: g('ntsConfirm').value, rating_high_text: g('ntsHigh').value, rating_mid_text: g('ntsMid').value, rating_low_text: g('ntsLow').value,
    rating_escalate_low: g('ntsEscalate').checked };
  if (body.mode === 'live' && _ntSettings.mode !== 'live' && !confirm('Включить боевой режим? Уведомления начнут уходить клиентам. Убедитесь, что Chatpush отключён в YClients (Интеграции → Уведомления), иначе клиенты получат дубли.')) return;
  try { _ntSettings = await api('/notification-rules/settings', { method: 'PUT', body }); notify('Сохранено'); g('ntSettings').classList.remove('open'); ntRenderMode(); }
  catch (e) { notify(e.message, 'error'); }
}
```

Если `api()` не умеет `FormData` (проверить `core/api.js`: нужен путь без `Content-Type: application/json` и без `JSON.stringify`) — добавить в `api()` ветку `if (opts.raw) { headers без Content-Type; body как есть }`.

- [ ] **Step 3: Подключить и бампнуть** — в `index.html` строку `<script src="js/pages/broadcast-rules.js?v=2026-08-02a"></script>` заменить на `<script src="js/pages/notifications.js?v=2026-10-13a"></script>`; `conditions-editor.js` должен быть подключён ДО него (сейчас после — переставить строки).

- [ ] **Step 4: Проверка глобальной области** — тест `frontend/js/pages/notifications.test.js` (`node --test`), грузящий `conditions-editor.js`, `broadcasts.js` и `notifications.js` подряд в один `vm`-контекст (образец — тест `chat-wait-status`): ни один файл не должен бросить `SyntaxError: Identifier … has already been declared`.

Run: `cd /root/loyalpro && node --test frontend/js/pages/notifications.test.js`
Expected: PASS.

- [ ] **Step 5: Живая проверка UI** — MCP Playwright (если недоступен — `backend/scripts/notifications-ui-e2e.js` на puppeteer, образец `scripts/reminders-ui-e2e.js`): логин владельцем на деве, «Рассылка» → «Автоуведомления»: список типов, создание правила «Напоминание» с условием по категории, загрузка картинки в правило `visit_after`, «Настройки» → режим «тень», журнал с фильтром, «Сверка с Chatpush». Скриншоты `/tmp/notify-ui-*.png`, обе темы.

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add frontend/index.html frontend/js/pages/notifications.js frontend/js/pages/notifications.test.js frontend/js/core/api.js
git commit -m "feat(notifications): вкладка «Уведомления» — правила по типам, настройки, журнал, оценки, сверка с Chatpush

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Живые проверки, runbook переключения, документация

**Files:**
- Create: `backend/scripts/notifications-e2e.js`, `backend/scripts/notifications-replies-e2e.js`, `backend/scripts/notifications-backfill-reminders.js`
- Modify: `backend/services/notifications/enroll.js` (экспорт `backfillReminders`), `backend/notifications-enroll.test.js`
- Create: `docs/2026-10-13-notifications-cutover-runbook.md`
- Modify: `CLAUDE.md` (новый раздел), `docs/superpowers/specs/2026-10-13-yclients-notifications-own-module-design.md` (статус)

- [ ] **Step 1: `notifications-e2e.js`** — без отправок (транспорт застаблен `--send` включает): (1) временно ставит салону режим `live` и правила всех семи типов на тестовый номер `79200255591` (тексты из `docs/notifications/chatpush-templates-2026-10-13.md`), (2) через `yclients-booking.ycCreateRecord` создаёт запись на завтра 12:00 → ждёт тик → в `notification_jobs` есть `record_created` (sent) и `visit_reminder` (pending, `scheduled_at` = завтра 12:00 − 24 ч → уже прошло → ОЖИДАЕМ, что job'а НЕТ, а в логе «момент уже прошёл»; для проверки напоминания создаётся вторая запись на послезавтра), (3) переносит запись `ycUpdateRecord` → старое напоминание `cancelled/перенесена`, новое `pending`, `record_rescheduled` sent, (4) ставит `attendance=1` → `visit_review` pending на конец визита + 5 мин, (5) удаляет запись → `record_cancelled` sent, все pending → cancelled; (6) `finally`: возвращает режим и правила салона как было, удаляет записи YClients. Образец структуры — `scripts/reminders-e2e.js` (отказ при `pm2` online без `--allow-worker-running`, потому что боевой тик дева арендует строки первым).

- [ ] **Step 2: `notifications-replies-e2e.js`** — in-process: вставляет `sent`-job `visit_reminder` по тестовому номеру с `yclients_record_id` живой тестовой записи, кладёт в `chatpush_messages` исходящее `system` с текстом напоминания, зовёт `replies.handleIncoming` с «Подтверждаю» → проверяет `attendance=2` через `ycGetRecord` и `confirmed_at`; затем job `visit_review` + «5» и «3» → строки `visit_ratings`, у «3» — `agent_dialogs.status='escalated'`. Отправка отбивки застаблена (`--send` шлёт). Чистит за собой.

- [ ] **Step 3: Догон напоминаний по уже существующим записям.** ЗАЧЕМ: `visit_reminder` ставится только на событии создания/переноса, а записи в клинике делают на недели вперёд. Без догона все визиты, записанные ДО включения тени, остались бы без нашего напоминания после отключения Chatpush. Догон запускается ОДИН раз — в начале тени (runbook, шаг 2), дальше новые записи идут вебхуком.

Тест (дописать в `backend/notifications-enroll.test.js`):

```js
describe('backfillReminders', () => {
  const rec = (over = {}) => ({ id: 200, datetime: '2026-10-25T12:00:00+03:00', seance_length: 3600, attendance: 0, deleted: false,
    sms_before: 0, client: { id: 7, phone: '79200255591', name: 'Анна' }, staff: { id: 55, name: 'Татьяна' },
    services: [{ id: 1, title: 'Пилинг' }], ...over });
  test('будущая живая запись → напоминание за 24 ч; прошедшая и отменённая — нет', async () => {
    setup({ rules: [rule({ id: 2, trigger_type: 'visit_reminder' })] });
    const r = await enroll.backfillReminders(salon, [
      rec(), rec({ id: 201, datetime: '2026-10-17T12:00:00+03:00' }), rec({ id: 202, attendance: -1 }), rec({ id: 203, deleted: true }),
    ], NOW);
    expect(r).toEqual({ scanned: 4, eligible: 1, queued: 1 });
    expect(inserts().map((p) => p[4])).toEqual([200]);
    expect(new Date(inserts()[0][6]).getTime()).toBe(Date.parse('2026-10-24T12:00:00+03:00'));
  });
  test('dryRun ничего не пишет в очередь', async () => {
    setup({ rules: [rule({ id: 2, trigger_type: 'visit_reminder' })] });
    const r = await enroll.backfillReminders(salon, [rec()], NOW, { dryRun: true });
    expect(r).toEqual({ scanned: 1, eligible: 1, queued: 0 });
    expect(inserts()).toHaveLength(0);
  });
});
```

Реализация — в конец `backend/services/notifications/enroll.js` (переиспользует локальные `saveState`/`insertJob`), и `backfillReminders` добавить в `module.exports`:

```js
/**
 * Догон напоминаний: records — живые записи YClients (форма data из /records).
 * Только visit_reminder и только будущие неотменённые визиты; момент — тот же
 * reminderAt, что у вебхука (тихие часы, sms_before). Повтор безопасен:
 * UNIQUE (правило, запись, момент визита) + ON CONFLICT DO NOTHING.
 */
async function backfillReminders(salon, records, nowMs = Date.now(), { dryRun = false } = {}) {
  const salonId = salon.id;
  const cfg = await settingsSvc.getSettings(salonId);
  const rules = await db.any(
    `SELECT * FROM notification_rules WHERE salon_id = $1 AND is_enabled = TRUE AND trigger_type = 'visit_reminder'`, [salonId]);
  const out = { scanned: records.length, eligible: 0, queued: 0 };
  if (!rules.length) return out;
  const catMap = await getServiceCategoryMap(salon).catch(() => new Map());
  const nameDictionary = await salonNames.load(salonId).catch(() => null);
  for (const rec of records) {
    const snap = ev.recordSnapshot({ status: 'update', data: rec });
    if (!Number.isInteger(snap.recordId) || snap.deleted || snap.attendance === -1 || snap.visitAt == null || snap.visitAt <= nowMs) continue;
    if (!dryRun) await saveState(salonId, snap);
    if (!snap.phone) continue;
    const client = snap.clientYcId ? await db.oneOrNone(
      'SELECT id, name, is_blacklisted FROM clients WHERE salon_id = $1 AND yclients_client_id = $2', [salonId, snap.clientYcId]) : null;
    if (client && client.is_blacklisted) continue;
    const serviceIds = snap.services.map((x) => x.id);
    const ctx = { staffId: snap.staffId, serviceIds,
      categoryIds: [...new Set(serviceIds.map((id) => catMap.get(String(id))).filter(Boolean))] };
    const renderCtx = buildRenderCtx(snap, salon, client, { nameDictionary });
    for (const rule of rules) {
      let ok = false;
      try { ok = evaluateRule(rule.conditions, ctx); } catch (e) { log.warn(`rule #${rule.id}: ${e.message}`); }
      if (!ok) continue;
      const at = ev.reminderAt(snap, rule, cfg, nowMs);
      if (at == null) continue;
      out.eligible += 1;
      if (!dryRun) out.queued += await insertJob(salonId, rule, snap, client, at,
        renderTemplate(rule.message_template, renderCtx), { meta: { backfill: true } });
    }
  }
  return out;
}
```

Скрипт `backend/scripts/notifications-backfill-reminders.js` (по умолчанию сухой прогон, `--write` ставит в очередь):

```js
'use strict';
// Разовый догон напоминаний о визите по записям, созданным ДО включения модуля.
// Запуск: cd backend && node scripts/notifications-backfill-reminders.js --salon=1 [--days=60] [--write]
const { db, pool } = require('../db');
const { ycGet } = require('../services/yclients');
const { backfillReminders } = require('../services/notifications/enroll');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);

(async () => {
  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id = $1', [Number(args.salon || 1)]);
  if (!salon) throw new Error('салон не найден');
  const days = Math.min(Math.max(Number(args.days || 60), 1), 180);
  const records = [];
  for (let page = 1; page <= 50; page++) {
    const batch = await ycGet(salon, `/records/${salon.yclients_company_id}`, {
      start_date: ymd(new Date()), end_date: ymd(new Date(Date.now() + days * 86400000)), count: 200, page });
    if (!Array.isArray(batch) || !batch.length) break;
    records.push(...batch);
  }
  const r = await backfillReminders(salon, records, Date.now(), { dryRun: !args.write });
  console.log(`${args.write ? 'WRITE' : 'DRY-RUN'}: записей ${r.scanned}, подходят под правила ${r.eligible}, поставлено ${r.queued}`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
```

Run: `cd /root/loyalpro/backend && npx jest notifications-enroll` → PASS (13 тестов); затем на деве `node scripts/notifications-backfill-reminders.js --salon=1` → строка `DRY-RUN: записей N, подходят …, поставлено 0` без ошибок.

- [ ] **Step 4: Runbook** `docs/2026-10-13-notifications-cutover-runbook.md`:

```markdown
# Переключение уведомлений YClients с Chatpush на LoyalPro — порядок действий

Предусловия: прод на коммите с модулем; `pm2 loyalpro` перезапущен (миграции прошли); все три канала клиники
(Telegram #8, WhatsApp #9, MAX) уже идут через наш шлюз — Chatpush нужен только как источник уведомлений YClients.

1. Админка → Рассылка → Автоуведомления → Настройки: режим «выключен». Завести правила по типам, тексты и картинки —
   из docs/notifications/chatpush-templates-2026-10-13.md и frontend/uploads/notify_seed (картинки загрузить в правила
   visit_after с условием «услуга/категория» по названию файла: Ботулинотерапия → категория «Ботулинотерапия» и т.д.).
   Каскад каналов: tdlib → whatsapp → max. В Настройках: текст подтверждения («✅ Ваша запись подтверждена…»),
   тексты оценок — 5: текст Chatpush «Спасибо за отличную оценку… Яндекс … 2ГИС … 500 бонусов», 4: «что улучшить»,
   2–3: «что не устроило» (перевод на администратора включён); тихие часы 21:00–09:00.
2. Режим «тень» на 3–5 дней. В первый же день: `node scripts/notifications-backfill-reminders.js --salon=1` (сухой
   прогон, проверить числа), затем с `--write` — напоминания по визитам, записанным до включения модуля. Каждый день: вкладка «Сверка с Chatpush» (или GET /api/notification-rules/parity?days=1):
   план ≈ Chatpush по каждому типу; расхождения разбирать по журналу (skipped/cancelled с причинами). Проверить тексты
   job'ов глазами: подстановки имени/даты/услуг.
3. Тест на свой номер (🧪 Тест) в режиме «тень» показывает только текст в журнале — реальную доставку на проде НЕ
   проверять переключением в «боевой»: в нём уйдут ВСЕ due-строки клиентов. Доставку проверять на деве скриптом
   notifications-e2e.js --send.
4. Переключение (в рабочее время, когда администратор на месте):
   a. YClients → Настройки → Интеграции → Уведомления → CHATPUSH (MessengeRocket) → «Отключить» (или выключить типы
      «Клиенту: …» по одному). С этого момента Chatpush ничего не шлёт.
   b. Сразу же Админка → Настройки → режим «боевой». Что прошло в тени, уже лежит в журнале как shadow (это отправил
      Chatpush); будущие строки (напоминания, в т.ч. из догона шага 2) остаются pending и уйдут от нас. Окно между a и b
      держать в пределах минут: за него не уйдёт ничего, кроме мгновенных «создана/перенесена/отменена» по записям
      этих минут (их можно отправить тестом руками по журналу shadow).
   c. Наблюдать журнал и `backend/logs`: первые «Подтверждаю» → `attendance=2` в YClients (видно в журнале записи),
      первые «5» → вкладка «Оценки».
5. Откат: режим «выключен» + включить CHATPUSH в YClients обратно.
6. Через неделю стабильной работы: выйти из Telegram/WhatsApp/MAX в кабинете Chatpush (теперь безопасно — уведомления в Telegram
   шлём мы), затем MAX/WhatsApp по решению §7, затем отказ от подписки Chatpush.
```

- [ ] **Step 5: CLAUDE.md** — добавить раздел после «Исходящие автоуведомления (`services/notifications.js`)…» в блоке AI-агента:

```markdown
### Уведомления YClients своими силами (с 2026-10-13, замена Chatpush)
Спека `docs/superpowers/specs/2026-10-13-yclients-notifications-own-module-design.md`, план `docs/superpowers/plans/2026-10-13-yclients-notifications-own-module.md`, runbook `docs/2026-10-13-notifications-cutover-runbook.md`. Модуль `services/notifications/` (events → render → rules → enroll → worker → replies → settings), фасад `services/notifications.js`. Семь `trigger_type` (создана/перенесена/отменена/напоминание за N ч/опрос после визита/рекомендации по услуге с картинкой/первый визит), очередь `notification_jobs` (UNIQUE правило+запись+момент визита; перенос = новый ключ), состояние записи `notification_record_state` (перенос распознаётся по нему — `records` к моменту хука уже перезаписан), настройки `notification_settings` с режимом `off|shadow|live`. Ответы «Подтверждаю»/«5» перехватывает `replies.handleIncoming` в `routes/chatpush-webhook.js` ДО `dispatcher.enqueue`, ТОЛЬКО в `live` (в тени отвечает Chatpush); условие двухчастное — последнее исходящее `system` и по тексту напоминание/опрос + наш `sent`-job по телефону; сбой YClients на подтверждении → ход Миле. Воркер перепроверяет состояние записи ПЕРЕД отправкой; каналы — только мессенджеры через свой шлюз (SMS нет, решение 14.10.2026); повтор только при однозначном отказе (4xx), таймаут → failed без повтора. Оценка: 5 — благодарность, 4 — «что улучшить», 2–3 — «что не устроило» + перевод на администратора. Тихие часы (дефолт 21:00–09:00) сдвигают только отложенные типы. Визиты, записанные до включения, догоняются `scripts/notifications-backfill-reminders.js`. Паритет с Chatpush — `GET /api/notification-rules/parity`.
```

- [ ] **Step 6: Прогнать всё**

Run: `cd /root/loyalpro/backend && npx jest notifications messaging-send-pacing chatpush-webhook-route care-worker reminders-worker 2>&1 | tail -8`
Expected: все сьюты PASS. Затем `node scripts/notifications-e2e.js` и `node scripts/notifications-replies-e2e.js` на деве (без `--send`) — PASS по всем шагам.

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro && git add backend/scripts/notifications-e2e.js backend/scripts/notifications-replies-e2e.js backend/scripts/notifications-backfill-reminders.js backend/services/notifications/enroll.js backend/notifications-enroll.test.js docs/2026-10-13-notifications-cutover-runbook.md CLAUDE.md docs/superpowers/specs/2026-10-13-yclients-notifications-own-module-design.md
git commit -m "feat(notifications): догон напоминаний, живые проверки, runbook переключения с Chatpush, раздел CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Самопроверка плана против спеки

- R1 типы: Task 5 (`enroll`), Task 8 (`TRIGGER_TYPES`); `birthday` — вне первого выката (спека §8).
- R2 ответы: Task 7; полосы оценки 5/4/2–3 и перевод при 2–3 — `notification_settings` (Task 2/5), тест на «4» в Task 7.
- R3 каналы: Task 6 (`resolveRouting`, `isDefiniteRejection`); SMS нет по решению владельца.
- R4 админка: Task 9; тест на свой номер, оценки — Task 8/9.
- R5 идемпотентность: уникальный индекс Task 2, гашение при переносе/отмене Task 5, mark-before-send Task 6.
- R6 тень и переход: режимы Task 5/6, паритет Task 8/9, runbook Task 10.
- Решения владельца 14.10.2026 учтены: MAX — свой шлюз; SMS нет; оценки 5/4/2–3; «Вы записаны» и для записей Милы (флага исключения нет, тест в Task 5); тихие часы 21:00–09:00 по умолчанию, только для отложенных типов (тест в Task 5).
- Напоминания по записям, созданным до включения модуля, — догон `backfillReminders` (Task 10, шаг 3; runbook, шаг 2).
