'use strict';
// ============================================================
// /api/notification-rules — уведомления YClients своим модулем (owner/admin)
// ============================================================
//
//   GET    /               правила салона со счётчиками job'ов (sent/shadow/pending/failed)
//   GET    /settings       настройки салона: режим off/shadow/live, каскад, тихие часы, тексты отбивок
//   PUT    /settings
//   GET    /jobs           журнал job'ов: ?type=&status=&date=YYYY-MM-DD&page=
//   POST   /jobs/:id/cancel  отменить запланированный (pending) job
//   GET    /ratings        оценки визитов + сводка за 30 дней
//   GET    /parity         паритет с Chatpush (теневой режим): наши job'ы против исходящих Chatpush по типу
//   GET    /dictionaries   специалисты, категории и услуги для пикеров условий
//   POST   /               создать правило
//   PUT    /:id            обновить правило (isEnabled не передан → включённость не меняется; выключено → очередь гасится)
//   POST   /:id/toggle     включить/выключить (выключение гасит pending-очередь правила в той же транзакции)
//   DELETE /:id            удалить (одна транзакция: pending-job'ы гасятся, история остаётся; файл вложения удаляется)
//   GET    /:id/jobs       журнал job'ов правила
//   POST   /:id/attachment  загрузить/заменить вложение (multipart, поле file; visit_after)
//   DELETE /:id/attachment
//   POST   /:id/test       тестовая отправка на свой номер (режим shadow/live; в off — 409, строка не создаётся)
//
// ПОРЯДОК ОБЪЯВЛЕНИЯ ВАЖЕН. Статические пути (/settings, /jobs, /ratings, /parity, /dictionaries)
// обязаны стоять РАНЬШЕ маршрутов с :id: иначе `PUT /settings` поймает `PUT /:id` (id = 'settings'),
// а `GET /jobs` — `GET /:id/...`. На это есть тест (router.stack + настоящие HTTP-запросы).
//
// ВНИМАНИЕ: поля JWT — req.user.salonId и req.user.userId (НЕ salon_id и НЕ id).
// Каждый запрос скоупится salon_id = req.user.salonId.
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { auth, requireRole } = require('../middleware/auth');
const { db, withTransaction } = require('../db');
const { ycGet } = require('../services/yclients');
const settingsSvc = require('../services/notifications/settings');
const { ALLOWED_CHANNELS } = require('../services/notifications/rules');
const { renderTemplate } = require('../services/notifications/render');
const { imageFileFilter, validateImageBuffer } = require('../utils/upload-validator');
const { createLogger } = require('../logger');

const log = createLogger('NotificationRules');
const guard = [auth, requireRole('owner', 'admin')];
const TRIGGER_TYPES = ['record_created', 'record_rescheduled', 'record_cancelled', 'visit_reminder', 'visit_review', 'visit_after', 'first_visit'];
const JOB_STATUSES = ['pending', 'sent', 'shadow', 'skipped', 'cancelled', 'failed'];

// Тело 500 видит владелец салона (и любой, кто украл его токен): строка подключения, имя таблицы, текст драйвера
// ему ни к чему. Наружу — общий текст, подробность — в лог (как routes/reminders.js и routes/care.js).
const INTERNAL_ERROR = 'Внутренняя ошибка';
function fail(res, where, e) {
  log.error(`${where}: ${e && e.message}`);
  return res.status(500).json({ error: INTERNAL_ERROR });
}

// Ошибки валидации сервиса настроек → 400 с понятным текстом (сообщение самого исключения наружу не уходит).
const SETTINGS_ERRORS = {
  BAD_TIME: 'Тихие часы: формат ЧЧ:ММ',
  BAD_MODE: 'Режим: off, shadow или live',
  BAD_CHANNELS: 'Порядок каскада: список мессенджеров (массив)',
};

// Шаблоны LIKE для служебных исходящих Chatpush по типу уведомления. Сверены с реальными текстами
// (docs/notifications/chatpush-templates-2026-10-13.md, тест notifications-routes.test.js читает этот файл):
//  • «перенесена»/«отменена» привязаны к «Ваша запись в…»: голое %отменена% цепляло реплику Милы,
//    ошибочно помеченную authored_by='system' («Прежняя запись на 6 октября отменена, поэтому…»);
//  • у отмены текст начинается с ❌, поэтому шаблон начинается с %, а не с эмодзи (его могут сменить);
//  • перед «Напоминаем о записи» сейчас стоит «Здравствуйте!» (у всех 513 за 60 дней), но шаблон на приветствие
//    не опирается — салон может его убрать, а ищется именно фраза напоминания.
const PARITY_PATTERNS = {
  record_created: 'Вы записаны на прием%',
  visit_reminder: '%Напоминаем о записи%',
  record_rescheduled: 'Ваша запись в%перенесена%',
  record_cancelled: '%Ваша запись в%отменена%',
  visit_review: 'Спасибо что посетили%',
  visit_after: 'Рекомендации после%',
  first_visit: 'Присоединяйтесь к программе%',
};

// ── файлы вложений ──
const uploadsDir = path.join(__dirname, '../../frontend/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const attachUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter,
  // multer по умолчанию читает имя файла как latin1: «Ботулинотерапия.jpg» приходило бы кракозябрами.
  defParamCharset: 'utf8',
});

// Расширение файла — по СИГНАТУРЕ содержимого, а не по имени, которое прислал клиент.
// Только то, что воркер умеет отдавать с правильным MIME (worker.js MIME: jpg/png/webp), поэтому GIF нет.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
function sniffImageExt(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return '.jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return '.png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return null;
}

// Имя файла вложения. Все три числа обязаны быть целыми — в имя на диске не попадёт ничего иного.
function attachmentFileName(salonId, ruleId, ext, ts) {
  if (![salonId, ruleId, ts].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('attachmentFileName: нечисловой идентификатор');
  if (!['.jpg', '.png', '.webp'].includes(ext)) throw new Error('attachmentFileName: неподдерживаемое расширение');
  return `notify_${salonId}_${ruleId}_${ts}${ext}`;
}

// Удаляем ТОЛЬКО файлы, созданные этим модулем: /uploads/notify_<салон>_<правило>_<ts>.<jpg|png|webp>.
// Сидовые картинки (/uploads/notify_seed/…), логотип, портфолио и КБ лежат в той же папке и сюда не попадают;
// «..», вложенные пути и любые другие расширения не проходят шаблон.
const OWN_ATTACHMENT_RE = /^\/uploads\/(notify_\d+_\d+_\d+\.(?:jpg|png|webp))$/;
function ownAttachmentFile(relUrl) {
  const m = typeof relUrl === 'string' ? OWN_ATTACHMENT_RE.exec(relUrl) : null;
  return m ? m[1] : null;
}
function safeUnlink(relUrl) {
  const name = ownAttachmentFile(relUrl);
  if (!name) return;
  fs.unlink(path.join(uploadsDir, name), (err) => {
    if (err && err.code !== 'ENOENT') log.warn(`unlink ${name}: ${err.message}`);
  });
}

// Подпись файла в интерфейсе — только для показа, на диск не попадает.
function attachmentLabel(name) {
  return String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255) || null;
}

/**
 * Прежний файл правила (заменили или удалили вложение) освобождается ТОЛЬКО когда на него больше не
 * ссылается ни один pending-job. Воркер правило не читает: job хранит attachment_url снимком и берёт
 * файл с диска при отправке, так что удалённый файл превратил бы запланированную отправку в
 * «файл вложения не найден». newUrl = null — вложение убрали вовсе (job уйдёт текстом).
 * Не бросает: при сбое файл остаётся на диске (лишний файл дешевле упавшей отправки).
 */
async function releaseOldAttachment(ruleId, salonId, oldUrl, newUrl) {
  if (!oldUrl) return;
  try {
    await db.query(
      `UPDATE notification_jobs SET attachment_url=$3
        WHERE rule_id=$1 AND salon_id=$2 AND status='pending' AND attachment_url=$4`,
      [ruleId, salonId, newUrl, oldUrl]);
  } catch (e) {
    log.warn(`перенацеливание pending-job'ов правила #${ruleId} не удалось (${e.message}) — старый файл оставлен`);
    return;
  }
  safeUnlink(oldUrl);
}

// id из URL — только положительное целое: parseInt('12abc') дал бы 12, а '1e3' и '1.5' тоже не id.
function idParam(v, max = 2147483647) {
  const s = String(v == null ? '' : v);
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= max ? n : null;
}

// YYYY-MM-DD, существующая календарная дата. Одного регэкспа мало: '2026-02-31' его проходит, а `$4::date`
// в PostgreSQL на такой строке падает («date/time field value out of range») → был 500. Невозможная дата, как и
// неверный формат, фильтр просто не включает. Годы 0000–0099 Date.UTC сдвигает в 1900-е — они отсекаются сверкой.
function calendarDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? m[0] : null;
}

/**
 * Выключенное правило не должно отправлять: job — снимок, воркер правило сам не читает (в staleReason есть и
 * проверка «правило выключено» на момент отправки, но очередь гасим сразу — счётчики и журнал показывают правду,
 * а не дожидаются due-времени). Вызывается ВНУТРИ транзакции, в которой правило получило новое состояние:
 * сбой гашения откатывает и само переключение. Включение погашенное не воскрешает.
 * Условие — по ИТОГОВОМУ состоянию правила, поэтому PUT выключенного правила (без isEnabled) тоже безвреден.
 */
async function cancelQueueIfDisabled(client, ruleId, salonId, rule) {
  if (rule.is_enabled !== false) return 0;
  const r = await client.query(
    "UPDATE notification_jobs SET status='cancelled', decision_reason='правило выключено' WHERE rule_id=$1 AND salon_id=$2 AND status='pending'",
    [ruleId, salonId]);
  return r.rowCount || 0;
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

  // Каналов у правила нет: порядок каскада и «сначала мессенджер последней переписки» — общие настройки
  // салона (notification_settings). Колонки v1 notification_rules.channels/prefer_last_channel остаются
  // в таблице и не читаются.

  // null = «не передано»: PUT оставляет состояние как есть (иначе правка текста выключенного правила включала бы его
  // обратно), POST включает. Не-булево — ошибка: опечатка в переключателе отправки не должна молча сработать как «вкл».
  let isEnabled = null;
  if (b.isEnabled != null) {
    if (typeof b.isEnabled !== 'boolean') return { error: 'isEnabled: true или false' };
    isEnabled = b.isEnabled;
  }

  const hoursBefore = triggerType === 'visit_reminder' ? intIn(b.hoursBefore, 1, 72, 24) : null;
  if (triggerType === 'visit_reminder' && hoursBefore == null) return { error: 'Часы до визита: число от 1 до 72' };
  const delayMinutes = (triggerType === 'visit_review' || triggerType === 'visit_after') ? intIn(b.delayMinutes, 0, 1440, 5) : null;
  if ((triggerType === 'visit_review' || triggerType === 'visit_after') && delayMinutes == null) return { error: 'Минут после визита: число от 0 до 1440' };

  return {
    value: {
      title, triggerType, messageTemplate: template, conditions: { logic, items },
      isEnabled,
      hoursBefore, delayMinutes,
      onNoShow: b.onNoShow !== false,
      askConfirmation: b.askConfirmation !== false,
    },
  };
}

const RULE_COLS = `title, is_enabled, trigger_type, conditions, message_template,
  hours_before, delay_minutes, on_no_show, ask_confirmation`;
function ruleParams(v) {
  return [v.title, v.isEnabled, v.triggerType, JSON.stringify(v.conditions), v.messageTemplate,
    v.hoursBefore, v.delayMinutes, v.onNoShow, v.askConfirmation];
}

// Колонки журнала job'ов — общие для /jobs и /:id/jobs.
const JOB_COLS = `j.id, j.rule_id, j.rule_title, j.trigger_type, j.yclients_record_id, j.visit_datetime, j.phone, j.status,
  j.attempts, j.error, j.rendered_text, j.attachment_url, j.routing, j.cascade_log, j.channel_used, j.delivery_id,
  j.scheduled_at, j.sent_at, j.created_at, j.confirmed_at, j.decision_reason, c.name AS client_name`;

// ════════════ статические пути — СТРОГО до :id-маршрутов ════════════

// ── настройки салона ──
router.get('/settings', guard, async (req, res) => {
  try { res.json(await settingsSvc.getSettings(req.user.salonId)); }
  catch (e) { fail(res, 'settings get', e); }
});
router.put('/settings', guard, async (req, res) => {
  try { res.json(await settingsSvc.updateSettings(req.user.salonId, req.body || {})); }
  catch (e) {
    if (e && Object.prototype.hasOwnProperty.call(SETTINGS_ERRORS, e.code)) return res.status(400).json({ error: SETTINGS_ERRORS[e.code] });
    fail(res, 'settings put', e);
  }
});

// ── журнал job'ов: ?type=&status=&date=YYYY-MM-DD&page= ──
router.get('/jobs', guard, async (req, res) => {
  try {
    const type = TRIGGER_TYPES.includes(req.query.type) ? req.query.type : null;
    const status = JOB_STATUSES.includes(req.query.status) ? req.query.status : null;
    const date = calendarDate(req.query.date);
    const page = Math.min(Math.max(0, parseInt(req.query.page || '0', 10) || 0), 10000);
    const items = await db.any(
      `SELECT ${JOB_COLS}
         FROM notification_jobs j LEFT JOIN clients c ON c.id = j.client_id AND c.salon_id = j.salon_id
        WHERE j.salon_id = $1
          AND ($2::text IS NULL OR j.trigger_type = $2)
          AND ($3::text IS NULL OR j.status = $3)
          AND ($4::date IS NULL OR (j.scheduled_at AT TIME ZONE 'Europe/Moscow')::date = $4::date)
        ORDER BY CASE WHEN j.status = 'pending' THEN j.scheduled_at END ASC, j.id DESC
        LIMIT 100 OFFSET $5`,
      [req.user.salonId, type, status, date, page * 100]);
    res.json({ items, page });
  } catch (e) { fail(res, 'jobs', e); }
});
router.post('/jobs/:id/cancel', guard, async (req, res) => {
  try {
    const id = idParam(req.params.id, Number.MAX_SAFE_INTEGER);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const r = await db.query(
      `UPDATE notification_jobs SET status='cancelled', decision_reason='отменено администратором'
        WHERE id=$1 AND salon_id=$2 AND status='pending'`, [id, req.user.salonId]);
    res.json({ ok: !!r.rowCount });
  } catch (e) { fail(res, 'job cancel', e); }
});

// ── оценки визитов ──
router.get('/ratings', guard, async (req, res) => {
  try {
    const items = await db.any(
      `SELECT v.id, v.yclients_record_id, v.phone, v.rating, v.comment, v.created_at, c.name AS client_name
         FROM visit_ratings v LEFT JOIN clients c ON c.id = v.client_id AND c.salon_id = v.salon_id
        WHERE v.salon_id = $1 ORDER BY v.created_at DESC LIMIT 500`, [req.user.salonId]);
    const stats = await db.oneOrNone(
      `SELECT count(*)::int AS n, round(avg(rating)::numeric, 2)::float AS avg,
              count(*) FILTER (WHERE rating >= 4)::int AS high, count(*) FILTER (WHERE rating < 4)::int AS low
         FROM visit_ratings WHERE salon_id = $1 AND created_at > NOW() - interval '30 days'`, [req.user.salonId]);
    res.json({ items, stats });
  } catch (e) { fail(res, 'ratings', e); }
});

// ── паритет с Chatpush: наши job'ы против служебных исходящих Chatpush по типу ──
// «Наши» считаются по моменту, на который job назначен (scheduled_at, до сейчас), а не по created_at:
// напоминание создаётся за дни до отправки, и по created_at окно «за сутки» сравнивало бы вчерашнее
// создание с сегодняшней отправкой Chatpush. Тестовые отправки администратора (meta.test) в счёт не идут.
// У Chatpush фильтра по provider НЕТ намеренно: уведомления YClients в Telegram приходят эхом через наш
// шлюз (provider = gateway либо NULL), и такой фильтр их бы потерял. В боевом режиме собственные
// отправки модуля тоже ложатся в chatpush_messages как authored_by='system', поэтому сверка осмысленна
// в теневом режиме (до переключения), а не после.
router.get('/parity', guard, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '7', 10) || 7, 1), 60);
    const salonId = req.user.salonId;
    const ours = await db.any(
      `SELECT trigger_type,
              count(*) FILTER (WHERE status IN ('sent','shadow'))::int AS planned,
              count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
              count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
         FROM notification_jobs
        WHERE salon_id = $1 AND scheduled_at > NOW() - make_interval(days => $2) AND scheduled_at <= NOW()
          AND COALESCE(meta->>'test', '') <> 'true'
        GROUP BY trigger_type`,
      [salonId, days]);
    // Имена колонок — из константы TRIGGER_TYPES (не из запроса), значения шаблонов — параметрами.
    const counters = TRIGGER_TYPES.map((t, i) => `count(*) FILTER (WHERE text LIKE $${i + 3})::int AS "${t}"`).join(', ');
    const theirs = await db.oneOrNone(
      `SELECT ${counters}
         FROM chatpush_messages
        WHERE salon_id = $1 AND direction = 'outgoing' AND authored_by = 'system'
          AND msg_ts > extract(epoch FROM NOW() - make_interval(days => $2))`,
      [salonId, days, ...TRIGGER_TYPES.map((t) => PARITY_PATTERNS[t])]);
    const byType = new Map((ours || []).map((r) => [r.trigger_type, r]));
    const items = TRIGGER_TYPES.map((t) => {
      const o = byType.get(t);
      return {
        triggerType: t,
        ours: o ? { planned: o.planned, skipped: o.skipped, cancelled: o.cancelled } : { planned: 0, skipped: 0, cancelled: 0 },
        chatpush: theirs && theirs[t] ? theirs[t] : 0,
      };
    });
    res.json({ days, items });
  } catch (e) { fail(res, 'parity', e); }
});

// Справочники для пикеров условий: специалисты из staff_members, категории и услуги — из booking-каталога
// YClients (полный список, включая неактивные: записи в вебхуке ссылаются и на выключенные услуги).
// channels — наследие v1 (пикер каналов старой вкладки); каскад v2 живёт в /settings.
router.get('/dictionaries', guard, async (req, res) => {
  try {
    const salon = await db.oneOrNone(
      `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
         FROM salons WHERE id = $1`,
      [req.user.salonId]
    );
    if (!salon) return res.status(404).json({ error: 'salon not found' });

    const staff = await db.any(
      `SELECT yclients_staff_id AS id, name, specialization
         FROM staff_members
        WHERE salon_id = $1 AND is_active = TRUE
        ORDER BY name`,
      [req.user.salonId]
    );

    let categories = [];
    let services = [];
    const cid = salon.yclients_company_id;
    if (cid) {
      const [cats, svcs] = await Promise.all([
        ycGet(salon, `/service_categories/${cid}`).catch(() => []),
        ycGet(salon, `/services/${cid}`).catch(() => []),
      ]);
      categories = (Array.isArray(cats) ? cats : [])
        .map((c) => ({ id: c.id, title: c.title }));
      services = (Array.isArray(svcs) ? svcs : [])
        .map((s) => ({ id: s.id, title: s.title, category_id: s.category_id }));
    }

    res.json({ staff, categories, services, channels: ALLOWED_CHANNELS });
  } catch (e) { fail(res, 'dictionaries', e); }
});

// ════════════ правила ════════════

router.get('/', guard, async (req, res) => {
  try {
    const rules = await db.any(
      `SELECT r.*, u.name AS author_name,
              COALESCE(s.sent, 0) AS sent_count, COALESCE(s.failed, 0) AS failed_count,
              COALESCE(s.pending, 0) AS pending_count, COALESCE(s.shadow, 0) AS shadow_count
         FROM notification_rules r
         LEFT JOIN users u ON u.id = r.created_by
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE j.status = 'sent')::int    AS sent,
                  count(*) FILTER (WHERE j.status = 'failed')::int  AS failed,
                  count(*) FILTER (WHERE j.status = 'pending')::int AS pending,
                  count(*) FILTER (WHERE j.status = 'shadow')::int  AS shadow
             FROM notification_jobs j WHERE j.rule_id = r.id AND j.salon_id = r.salon_id
         ) s ON TRUE
        WHERE r.salon_id = $1 ORDER BY r.trigger_type, r.id`,
      [req.user.salonId]);
    res.json({ rules, triggerTypes: TRIGGER_TYPES });
  } catch (e) { fail(res, 'list', e); }
});

router.post('/', guard, async (req, res) => {
  try {
    const { error, value } = parseRuleBody(req.body);
    if (error) return res.status(400).json({ error });
    // Дефолт «включено» живёт только здесь: parseRuleBody отдаёт null, когда isEnabled не передан (для PUT это
    // «оставить как есть»).
    const rule = await db.one(
      `INSERT INTO notification_rules (salon_id, ${RULE_COLS}, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.user.salonId, ...ruleParams({ ...value, isEnabled: value.isEnabled !== false }), req.user.userId ?? null]);
    res.json({ ok: true, rule });
  } catch (e) { fail(res, 'create', e); }
});

router.put('/:id', guard, async (req, res) => {
  try {
    const id = idParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const { error, value } = parseRuleBody(req.body);
    if (error) return res.status(400).json({ error });
    const salonId = req.user.salonId;
    // is_enabled=COALESCE($4, is_enabled): isEnabled не передан → null → состояние не трогаем (правка текста
    // выключенного правила его не включает). Правило стало (или осталось) выключенным — гасим его очередь в той же
    // транзакции.
    const out = await withTransaction(async (client) => {
      const r = await client.query(
        `UPDATE notification_rules SET title=$3, is_enabled=COALESCE($4, is_enabled), trigger_type=$5, conditions=$6::jsonb, message_template=$7,
            hours_before=$8, delay_minutes=$9, on_no_show=$10, ask_confirmation=$11, updated_at=NOW()
          WHERE id=$1 AND salon_id=$2 RETURNING *`,
        [id, salonId, ...ruleParams(value)]);
      const rule = r.rows[0];
      if (!rule) return null;
      return { rule, cancelledJobs: await cancelQueueIfDisabled(client, id, salonId, rule) };
    });
    if (!out) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, rule: out.rule, cancelledJobs: out.cancelledJobs });
  } catch (e) { fail(res, 'update', e); }
});

router.post('/:id/toggle', guard, async (req, res) => {
  try {
    const id = idParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const salonId = req.user.salonId;
    // Переключение и гашение очереди — одна транзакция: «правило выключено», но с живой очередью, не бывает.
    const out = await withTransaction(async (client) => {
      const r = await client.query(
        `UPDATE notification_rules
            SET is_enabled = NOT is_enabled, updated_at = NOW()
          WHERE id=$1 AND salon_id=$2
          RETURNING *`,
        [id, salonId]);
      const rule = r.rows[0];
      if (!rule) return null;
      return { rule, cancelledJobs: await cancelQueueIfDisabled(client, id, salonId, rule) };
    });
    if (!out) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, rule: out.rule, cancelledJobs: out.cancelledJobs });
  } catch (e) { fail(res, 'toggle', e); }
});

router.delete('/:id', guard, async (req, res) => {
  try {
    const id = idParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const salonId = req.user.salonId;
    // Воркер правило не читает (job живёт своим текстом и вложением), а FK notification_jobs.rule_id —
    // ON DELETE SET NULL: история остаётся, но запланированная отправка пережила бы правило. Поэтому одна транзакция:
    //  1) блокируем строку правила (FOR UPDATE): параллельная постановка job'а берёт на неё FK-замок и ждёт нас,
    //     а после коммита получает отказ FK — «осиротевший» pending не появляется;
    //  2) гасим pending-job'ы, пока их ещё можно найти по rule_id (после удаления он станет NULL);
    //  3) удаляем правило. Сбой на любом шаге откатывает всё: правило не остаётся без очереди и наоборот.
    const gone = await withTransaction(async (client) => {
      const sel = await client.query(
        'SELECT attachment_url FROM notification_rules WHERE id=$1 AND salon_id=$2 FOR UPDATE', [id, salonId]);
      const rule = sel.rows[0];
      if (!rule) return null;
      await client.query(
        "UPDATE notification_jobs SET status='cancelled', decision_reason='правило удалено' WHERE rule_id=$1 AND salon_id=$2 AND status='pending'",
        [id, salonId]);
      await client.query('DELETE FROM notification_rules WHERE id=$1 AND salon_id=$2', [id, salonId]);
      return rule;
    });
    if (!gone) return res.status(404).json({ error: 'not found' });
    safeUnlink(gone.attachment_url);      // только после коммита: при откате файл остаётся у уцелевшего правила
    res.json({ ok: true });
  } catch (e) { fail(res, 'delete', e); }
});

// Журнал job'ов одного правила (свежие сверху).
router.get('/:id/jobs', guard, async (req, res) => {
  try {
    const id = idParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
    const items = await db.any(
      `SELECT ${JOB_COLS}
         FROM notification_jobs j LEFT JOIN clients c ON c.id = j.client_id AND c.salon_id = j.salon_id
        WHERE j.rule_id = $1 AND j.salon_id = $2
        ORDER BY j.id DESC
        LIMIT $3`,
      [id, req.user.salonId, limit]);
    res.json({ items });
  } catch (e) { fail(res, 'rule jobs', e); }
});

// ── вложение правила (visit_after): multipart, поле file ──
router.post('/:id/attachment', guard, (req, res) => {
  const id = idParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });      // до разбора тела: файл не читаем зря
  attachUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой: лимит 5 МБ' : err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран или формат не поддерживается (JPEG, PNG, WEBP)' });
    const valid = validateImageBuffer(req.file.buffer, req.file.originalname);
    if (!valid.ok) return res.status(400).json({ error: valid.error });
    const ext = sniffImageExt(req.file.buffer);
    if (!ext) return res.status(400).json({ error: 'Формат не поддерживается (JPEG, PNG, WEBP)' });

    const salonId = req.user.salonId;
    let written = false;       // файл создан НАМИ в этом запросе
    let committed = false;     // правило уже ссылается на файл — убирать его нельзя
    let fileUrl = null;
    try {
      const fileName = attachmentFileName(salonId, id, ext, Date.now());
      fileUrl = `/uploads/${fileName}`;
      const old = await db.oneOrNone('SELECT attachment_url FROM notification_rules WHERE id=$1 AND salon_id=$2', [id, salonId]);
      if (!old) return res.status(404).json({ error: 'not found' });
      // 'wx': существующий файл не перезаписываем (и, как следствие, чужой при сбое не удалим).
      await fs.promises.writeFile(path.join(uploadsDir, fileName), req.file.buffer, { flag: 'wx' });
      written = true;
      const upd = await db.query(
        'UPDATE notification_rules SET attachment_url=$3, attachment_name=$4, updated_at=NOW() WHERE id=$1 AND salon_id=$2',
        [id, salonId, fileUrl, attachmentLabel(req.file.originalname)]);
      if (!upd.rowCount) {     // правило удалили между проверкой и записью
        safeUnlink(fileUrl);
        return res.status(404).json({ error: 'not found' });
      }
      committed = true;
      await releaseOldAttachment(id, salonId, old.attachment_url, fileUrl);
      res.json({ ok: true, attachmentUrl: fileUrl });
    } catch (e) {
      if (written && !committed) safeUnlink(fileUrl);
      fail(res, 'attachment upload', e);
    }
  });
});

router.delete('/:id/attachment', guard, async (req, res) => {
  try {
    const id = idParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const salonId = req.user.salonId;
    const old = await db.oneOrNone('SELECT attachment_url FROM notification_rules WHERE id=$1 AND salon_id=$2', [id, salonId]);
    if (!old) return res.status(404).json({ error: 'not found' });
    await db.query('UPDATE notification_rules SET attachment_url=NULL, attachment_name=NULL, updated_at=NOW() WHERE id=$1 AND salon_id=$2', [id, salonId]);
    await releaseOldAttachment(id, salonId, old.attachment_url, null);
    res.json({ ok: true });
  } catch (e) { fail(res, 'attachment delete', e); }
});

// ── тест на свой номер: job «сейчас», тем же воркером; перепроверку состояния записи пропускает
//    meta.test (но строку старше 30 минут воркер гасит: staleReason, TEST_MAX_AGE_MS).
//    Что случится со строкой, зависит от режима — ответ ручки говорит это явно:
//    live → уйдёт; shadow → ляжет в журнал со статусом shadow. В режиме off (и в неизвестном) воркер
//    строки салона не арендует: тест висел бы pending и ушёл бы при включении боевого режима сколько
//    угодно позже — поэтому там 409 и строка НЕ создаётся. ──
const TEST_NOTES = {
  live: 'уйдёт в течение 10 с',
  shadow: 'режим «shadow»: строка попадёт в журнал без отправки',
};
const TEST_OFF_ERROR = 'Модуль выключен: тестовая отправка не уйдёт. Переключите режим в «тень» (текст попадёт в журнал) или «боевой»';
router.post('/:id/test', guard, async (req, res) => {
  try {
    const id = idParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const phone = String((req.body || {}).phone || '').replace(/\D/g, '').replace(/^8/, '7');
    if (!/^7\d{10}$/.test(phone)) return res.status(400).json({ error: 'Номер: 11 цифр, начиная с 7' });
    const rule = await db.oneOrNone('SELECT * FROM notification_rules WHERE id=$1 AND salon_id=$2', [id, req.user.salonId]);
    if (!rule) return res.status(404).json({ error: 'not found' });
    const cfg = await settingsSvc.getSettings(req.user.salonId);
    if (!cfg || (cfg.mode !== 'live' && cfg.mode !== 'shadow')) return res.status(409).json({ error: TEST_OFF_ERROR, mode: (cfg && cfg.mode) || null });
    const text = renderTemplate(rule.message_template, {
      name: 'Тест Тестовна', date: '31.12.2026', time: '12:00', end_time: '13:00',
      services: 'Тестовая услуга', staff: 'Мастер', salon: 'Салон', record_link: 'https://example.com', rating_links: '',
    });
    // Ключ уникальности (rule_id, yclients_record_id=0, 'epoch'): повторный тест того же правила попадает в ту же
    // строку, и DO UPDATE обязан вернуть её в состояние «только что поставлена» — иначе второй тест молча
    // не сработает (статус sent/shadow, attempts, cascade_pos, delivery_id и check_at остались бы от первого).
    const row = await db.one(
      `INSERT INTO notification_jobs (salon_id, rule_id, rule_title, trigger_type, yclients_record_id, visit_datetime, phone,
          scheduled_at, rendered_text, attachment_url, meta, decision_reason)
       VALUES ($1,$2,$3,$4,0,NULL,$5,NOW(),$6,$7,'{"test":true}'::jsonb,'тестовая отправка')
       ON CONFLICT (rule_id, yclients_record_id, COALESCE(visit_datetime, 'epoch'::timestamptz)) DO UPDATE SET
          rule_title=EXCLUDED.rule_title, trigger_type=EXCLUDED.trigger_type, phone=EXCLUDED.phone,
          rendered_text=EXCLUDED.rendered_text, attachment_url=EXCLUDED.attachment_url, meta=EXCLUDED.meta,
          status='pending', scheduled_at=NOW(), attempts=0, error=NULL, sent_at=NULL, channel_used=NULL,
          delivery_id=NULL, account_id=NULL, check_at=NULL, confirmed_at=NULL, cascade_pos=0, routing=NULL,
          cascade_log='[]'::jsonb, decision_reason='тестовая отправка', last_attempt_at=NULL,
          client_id=NULL, created_at=NOW()
       RETURNING id`,
      [req.user.salonId, rule.id, rule.title, rule.trigger_type, phone, text, rule.attachment_url]);
    res.json({ ok: true, jobId: row.id, mode: cfg.mode, note: TEST_NOTES[cfg.mode] });
  } catch (e) { fail(res, 'test', e); }
});

module.exports = router;
module.exports.parseRuleBody = parseRuleBody;
module.exports.TRIGGER_TYPES = TRIGGER_TYPES;
module.exports.PARITY_PATTERNS = PARITY_PATTERNS;
module.exports.sniffImageExt = sniffImageExt;
module.exports.ownAttachmentFile = ownAttachmentFile;
