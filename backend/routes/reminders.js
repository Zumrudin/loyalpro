// ============================================================
// Напоминания о повторном визите (вкладки страницы «Забота»)
// ============================================================
//
// Mounted at /api/reminders. owner/admin only (глобальный гейт в
// routes/index.js: /api/reminders не входит в SPECIALIST/CASHIER_ALLOWED_PREFIXES).
//
//   GET    /rules                       правила со счётчиками
//   POST   /rules                       создать
//   PUT    /rules/:id                   обновить
//   POST   /rules/:id/toggle            вкл/выкл
//   DELETE /rules/:id                   удалить (история остаётся: rule_id → NULL)
//   POST   /rules/:id/backfill/preview  превью догона
//   POST   /rules/:id/backfill          выполнить догон
//   POST   /rules/:id/test              тестовая отправка на указанный номер
//   POST   /queue/:id/cancel            отменить запланированную
//   GET    /history                     журнал с фильтрами (включая scheduled)
//   POST   /suppressions/toggle         ручной тумблер анти-повтора
//
// ВНИМАНИЕ: поля JWT — req.user.salonId и req.user.userId (НЕ salon_id).
const router = require('express').Router();
const { auth, requireRole } = require('../middleware/auth');
const { db } = require('../db');
const { createLogger } = require('../logger');
const { ycGet } = require('../services/yclients');
const { getServiceCategoryMap } = require('../services/notifications');
const { normalizePhoneKey } = require('../services/agent-gate');
const { matchBackfillVisits, planBackfillSchedule } = require('../services/reminders/backfill');
const { TIER_ACTIONS } = require('../services/reminders/tiers');
const { pickAnchorVisit, buildTestRow } = require('../services/reminders/test-send');
const remindersWorker = require('../services/reminders/worker');
const { ycGetClientRecords } = require('../services/yclients-records');
const identity = require('../services/agent/identity');

const log = createLogger('Reminders');
const guard = [auth, requireRole('owner', 'admin')];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TEXT_MODES = ['free', 'strict'];
const PAGE = 200;
const MAX_PAGES = 25;                 // 5000 записей — потолок одного догона
const MAX_BONUS_TIERS = 20;           // тот же кап, что на касания в care.js
const BACKFILL_BATCH = 500;           // 12 параметров/строку × 500 = 6000 плейсхолдеров —
                                       // с запасом под лимит PostgreSQL в 65535
// Догон, уже идущий по правилу (id → true) — защита от двойного клика/двух
// администраторов: без неё два одновременных запуска оба тянут до 25 страниц
// YClients и оба считают выборку. Это ПРОЦЕССНАЯ защита (на проде — один
// процесс PM2 fork), а не распределённый лок: при переходе на несколько
// инстансов нужен отдельный механизм (в стиле _tickInFlight воркера).
const backfillInFlight = new Set();

/** 'YYYY-MM-DD' московской даты (как в care/preview.js). */
function mskDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);
}

/** Валидация тела правила → { error } | { value }. */
function parseRuleBody(body) {
  const b = body || {};
  const title = String(b.title || '').trim();
  if (!title) return { error: 'Название обязательно' };
  if (title.length > 255) return { error: 'Название слишком длинное' };

  const c = b.conditions || {};
  const logic = c.logic === 'or' ? 'or' : 'and';
  const items = (Array.isArray(c.items) ? c.items : [])
    .filter(it => it && ['staff', 'category', 'service'].includes(it.type))
    .map(it => ({ type: it.type, ids: (Array.isArray(it.ids) ? it.ids : []).map(Number).filter(Number.isFinite) }))
    .filter(it => it.ids.length);
  if (!items.length) return { error: 'Нужно хотя бы одно условие: без него напоминание уйдёт после ЛЮБОГО визита' };

  const delay = Number(b.delayDays);
  if (!Number.isInteger(delay) || delay < 1 || delay > 730) return { error: 'Задержка 1–730 дней' };

  const text = String(b.text || '').trim();
  if (!text) return { error: 'Текст напоминания пуст' };
  if (text.length > 2000) return { error: 'Текст слишком длинный' };

  const attributionDays = Number(b.attributionDays);
  if (!Number.isInteger(attributionDays) || attributionDays < 1 || attributionDays > 365) {
    return { error: 'Окно атрибуции 1–365 дней' };
  }
  const cap = Number(b.backfillMaxPerDay);
  if (!Number.isInteger(cap) || cap < 1 || cap > 500) return { error: 'Кап догона 1–500 в день' };

  // Ступени бонусов: суммы уходят реальными деньгами на карту клиента,
  // поэтому валидация недоверчивая — неизвестное действие отвергаем, а не
  // молча игнорируем.
  const rawTiers = Array.isArray(b.bonusTiers) ? b.bonusTiers : [];
  if (rawTiers.length > MAX_BONUS_TIERS) return { error: `Слишком много ступеней (макс ${MAX_BONUS_TIERS})` };
  const tiers = [];
  for (const [i, t] of rawTiers.entries()) {
    if (!t || !TIER_ACTIONS.includes(t.action)) return { error: `Ступень ${i + 1}: неизвестное действие` };
    const upTo = t.upTo === null || t.upTo === undefined || t.upTo === '' ? null : Number(t.upTo);
    if (upTo !== null && (!Number.isFinite(upTo) || upTo < 0)) return { error: `Ступень ${i + 1}: неверный порог` };
    const amount = Math.max(0, Math.round(Number(t.amount) || 0));
    if (t.action === 'accrue' && amount <= 0) return { error: `Ступень ${i + 1}: сумма начисления должна быть больше нуля` };
    if (amount > 100000) return { error: `Ступень ${i + 1}: сумма начисления слишком велика` };
    tiers.push({ up_to: upTo, action: t.action, amount, text: String(t.text || '').slice(0, 2000) });
  }
  if (b.bonusEnabled && !tiers.length) return { error: 'Бонусы включены, но ни одной ступени не задано' };

  return { value: {
    title,
    conditions: { logic, items },
    delayDays: delay,
    sendTime: TIME_RE.test(String(b.sendTime || '')) ? b.sendTime : '11:00',
    textMode: TEXT_MODES.includes(b.textMode) ? b.textMode : 'strict',
    text,
    attributionDays,
    bonusEnabled: !!b.bonusEnabled,
    bonusTiers: tiers,
    backfillMaxPerDay: cap,
  } };
}

const RULE_COLUMNS = `
  id, title, is_enabled AS "isEnabled", conditions, delay_days AS "delayDays",
  send_time AS "sendTime", text_mode AS "textMode", text,
  attribution_days AS "attributionDays", bonus_enabled AS "bonusEnabled",
  bonus_tiers AS "bonusTiers", backfill_max_per_day AS "backfillMaxPerDay",
  created_at AS "createdAt"`;

// GET /rules — правила со счётчиками очереди, отправок и конверсии.
router.get('/rules', guard, async (req, res) => {
  try {
    const rows = await db.any(
      `SELECT ${RULE_COLUMNS},
              (SELECT count(*) FROM reminder_queue q
                WHERE q.rule_id = r.id AND q.status = 'scheduled')::int AS "queuedCount",
              (SELECT count(*) FROM reminder_queue q
                WHERE q.rule_id = r.id AND q.status = 'sent')::int AS "sentCount",
              (SELECT count(*) FROM reminder_queue q
                WHERE q.rule_id = r.id AND q.conversion_record_id IS NOT NULL)::int AS "convertedCount",
              (SELECT count(*) FROM reminder_queue q
                WHERE q.rule_id = r.id AND q.visited_at IS NOT NULL)::int AS "visitedCount",
              (SELECT COALESCE(sum(q.bonus_accrued), 0) FROM reminder_queue q
                WHERE q.rule_id = r.id)::int AS "bonusTotal"
         FROM reminder_rules r
        WHERE r.salon_id = $1
        ORDER BY r.created_at DESC`,
      [req.user.salonId]);
    res.json({ rules: rows });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Не удалось загрузить правила' }); }
});

router.post('/rules', guard, async (req, res) => {
  const parsed = parseRuleBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;
  try {
    const row = await db.one(
      `INSERT INTO reminder_rules
         (salon_id, title, conditions, delay_days, send_time, text_mode, text,
          attribution_days, bonus_enabled, bonus_tiers, backfill_max_per_day, created_by)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
       RETURNING ${RULE_COLUMNS}`,
      [req.user.salonId, v.title, JSON.stringify(v.conditions), v.delayDays, v.sendTime,
       v.textMode, v.text, v.attributionDays, v.bonusEnabled, JSON.stringify(v.bonusTiers),
       v.backfillMaxPerDay, req.user.userId]);
    res.json({ rule: row });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Не удалось создать правило' }); }
});

router.put('/rules/:id', guard, async (req, res) => {
  const parsed = parseRuleBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;
  try {
    const row = await db.oneOrNone(
      `UPDATE reminder_rules
          SET title=$3, conditions=$4::jsonb, delay_days=$5, send_time=$6, text_mode=$7,
              text=$8, attribution_days=$9, bonus_enabled=$10, bonus_tiers=$11::jsonb,
              backfill_max_per_day=$12, updated_at=NOW()
        WHERE id=$1 AND salon_id=$2
        RETURNING ${RULE_COLUMNS}`,
      [req.params.id, req.user.salonId, v.title, JSON.stringify(v.conditions), v.delayDays,
       v.sendTime, v.textMode, v.text, v.attributionDays, v.bonusEnabled,
       JSON.stringify(v.bonusTiers), v.backfillMaxPerDay]);
    if (!row) return res.status(404).json({ error: 'Правило не найдено' });
    // rule_title в очереди денормализован ради истории — синхронизируем.
    await db.query(`UPDATE reminder_queue SET rule_title=$2 WHERE rule_id=$1`, [req.params.id, v.title]);
    res.json({ rule: row });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Не удалось сохранить правило' }); }
});

router.post('/rules/:id/toggle', guard, async (req, res) => {
  try {
    const row = await db.oneOrNone(
      `UPDATE reminder_rules SET is_enabled = NOT is_enabled, updated_at=NOW()
        WHERE id=$1 AND salon_id=$2 RETURNING id, is_enabled AS "isEnabled"`,
      [req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Правило не найдено' });
    res.json(row);
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Не удалось переключить правило' }); }
});

// DELETE — история НЕ удаляется: rule_id уходит в NULL (ON DELETE SET NULL),
// rule_title в строках остаётся. Запланированные строки гасит воркер (ORPHAN_SQL).
router.delete('/rules/:id', guard, async (req, res) => {
  try {
    const row = await db.oneOrNone(
      `DELETE FROM reminder_rules WHERE id=$1 AND salon_id=$2 RETURNING id`,
      [req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Правило не найдено' });
    res.json({ ok: true });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Не удалось удалить правило' }); }
});

/** Общая подготовка догона: тянет записи и считает выборку (ничего не пишет). */
async function buildBackfill(salonId, ruleId, days) {
  const rule = await db.oneOrNone(
    `SELECT * FROM reminder_rules WHERE id=$1 AND salon_id=$2`, [ruleId, salonId]);
  if (!rule) return { error: 'Правило не найдено', code: 404 };

  // db.one в этом проекте НЕ бросает на пустой выборке — побайтово совпадает
  // с oneOrNone (db.js:28-29), поэтому null проверяем явно. 404, а не 400:
  // это тот же класс «ресурс не найден», что и проверка rule чуть выше —
  // salon_id берётся из JWT, и его отсутствие в salons означает битый токен
  // или удалённый салон, а не ошибку в теле запроса клиента.
  const salon = await db.oneOrNone(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);
  if (!salon) return { error: 'Салон не найден', code: 404 };
  if (!salon.yclients_company_id) return { error: 'У салона не настроен YClients', code: 400 };

  const nowMs = Date.now();
  // Диапазон захватывает и будущее: будущие записи нужны, чтобы отсеять уже
  // записавшихся клиентов, и брать их отдельным запросом на каждого нельзя.
  const startDate = mskDate(new Date(nowMs - days * 86400000));
  const endDate = mskDate(new Date(nowMs + 90 * 86400000));
  let records = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const chunk = await ycGet(salon, `/records/${salon.yclients_company_id}`,
      { start_date: startDate, end_date: endDate, page, count: PAGE });
    if (!Array.isArray(chunk) || !chunk.length) break;
    records = records.concat(chunk);
    if (chunk.length < PAGE) break;
  }

  const catMap = await getServiceCategoryMap(salon).catch(() => new Map());
  const bl = await db.any(
    `SELECT phone FROM clients WHERE salon_id=$1 AND is_blacklisted = TRUE AND phone IS NOT NULL`,
    [salonId]);
  const muted = await db.any(
    `SELECT phone FROM reminder_suppressions WHERE rule_id=$1 AND muted = TRUE`, [ruleId]);
  const queued = await db.any(
    `SELECT anchor_record_id FROM reminder_queue WHERE rule_id=$1`, [ruleId]);

  const out = matchBackfillVisits({
    records,
    conditions: rule.conditions,
    catMap,
    blacklisted: new Set(bl.map(r => normalizePhoneKey(r.phone)).filter(Boolean)),
    mutedPhones: new Set(muted.map(r => r.phone)),
    queuedRecordIds: new Set(queued.map(r => String(r.anchor_record_id))),
    nowMs,
  });
  return { rule, out, catMapFailed: catMap.size === 0, startDate, endDate };
}

/**
 * Сводка плана догона для превью: две корзины (просроченные/будущие) считаются
 * РАЗДЕЛЬНО, а не общим максимумом — иначе дата одной корзины подписывается
 * под числом другой (фронт печатает lastFutureAt подписью именно к будущей
 * корзине: «встанут в очередь на будущее: 0 · последнее 09.08»; общий
 * lastScheduledAt тут дал бы дату догоняющей пачки под нулём). lastScheduledAt
 * (максимум по ОБЕИМ корзинам) сохранён — его уже читает задеплоенный фронт.
 *
 * Дата отправки проставляется в rows ТОЛЬКО строкам без skipReason:
 * matchBackfillVisits не дедуплицирует записи YClients (сдвиг пагинации —
 * известный класс), и строка-близнец с skipReason:'superseded' не должна
 * получить дату в колонке «Отправка» — она и так не уйдёт.
 *
 * maxAt — reduce, а не Math.max(...arr): spread на массиве, размер которого
 * ограничен только потолком догона (MAX_PAGES*PAGE = 5000, см. buildBackfill
 * выше), рушится на «Maximum call stack size exceeded»; reduce от размера
 * входа не зависит.
 *
 * @param {object[]} rows выборка visitов (r.out.rows, включая skipReason)
 * @param {object[]} planned результат planBackfillSchedule, УЖЕ отфильтрованный
 *   по scheduledAt (порядок массива НЕ гарантирует возрастания дат — см.
 *   комментарий в backfill.js)
 * @returns {{ rows: object[], overdueCount: number, futureCount: number,
 *   lastOverdueAt: Date|null, lastFutureAt: Date|null, lastScheduledAt: Date|null }}
 */
function summarizeBackfillPlan(rows, planned) {
  const list = Array.isArray(planned) ? planned : [];
  const overdue = list.filter(p => p.overdue);
  const future = list.filter(p => !p.overdue);

  const maxMs = (arr) => arr.reduce((max, p) => {
    const t = p.scheduledAt.getTime();
    return max === null || t > max ? t : max;
  }, null);
  const toDate = (ms) => (ms === null ? null : new Date(ms));

  const whenBy = new Map(list.map(p => [String(p.recordId), p.scheduledAt]));
  const outRows = (Array.isArray(rows) ? rows : []).map(x => ({
    ...x,
    scheduledAt: x.skipReason ? null : (whenBy.get(String(x.recordId)) || null),
  }));

  return {
    rows: outRows,
    overdueCount: overdue.length,
    futureCount: future.length,
    lastOverdueAt: toDate(maxMs(overdue)),
    lastFutureAt: toDate(maxMs(future)),
    lastScheduledAt: toDate(maxMs(list)),
  };
}

router.post('/rules/:id/backfill/preview', guard, async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.body && req.body.days) || 30));
  try {
    const r = await buildBackfill(req.user.salonId, req.params.id, days);
    if (r.error) return res.status(r.code).json({ error: r.error });
    const planned = planBackfillSchedule(r.out.rows.filter(x => !x.skipReason), {
      delayDays: r.rule.delay_days, sendTime: r.rule.send_time,
      maxPerDay: r.rule.backfill_max_per_day }).filter(x => x.scheduledAt);

    const summary = summarizeBackfillPlan(r.out.rows, planned);
    res.json({ totals: r.out.totals, days, catMapFailed: r.catMapFailed, ...summary });
  } catch (e) {
    log.error(`превью догона правила #${req.params.id}: ${e.message}`);
    res.status(500).json({ error: 'Не удалось построить выборку' });
  }
});

// Клиентов правила резолвим ОДНИМ запросом до цикла вставки (вместо SELECT
// на каждую строку) — при потолке 5000 записей отдельные запросы упирались
// в дефолтный proxy_read_timeout nginx (60с), админ видел 504, а цикл в
// Node продолжал писать в фоне: «ошибка» на экране при успешно легших
// строках. Приоритет соответствия — как раньше: сначала yclients_client_id,
// потом телефон.
async function resolveClients(salonId, rows) {
  const ycIds = [...new Set(rows.map(r => r.ycClientId).filter(v => v != null))];
  const phones = [...new Set(rows.map(r => r.phone).filter(Boolean))];
  const byYcId = new Map();
  const byPhone = new Map();
  if (!ycIds.length && !phones.length) return { byYcId, byPhone };
  const found = await db.any(
    `SELECT id, yclients_client_id, phone FROM clients
      WHERE salon_id=$1 AND (yclients_client_id = ANY($2::bigint[]) OR phone = ANY($3::text[]))`,
    [salonId, ycIds, phones]);
  for (const c of found) {
    if (c.yclients_client_id != null && !byYcId.has(String(c.yclients_client_id))) {
      byYcId.set(String(c.yclients_client_id), c.id);
    }
    if (c.phone && !byPhone.has(c.phone)) byPhone.set(c.phone, c.id);
  }
  return { byYcId, byPhone };
}

// Пачка многострочного INSERT вместо построчного — тот же таймаут-риск, что
// у per-row SELECT клиента выше. Размер пачки (BACKFILL_BATCH=500) выбран с
// запасом от лимита PostgreSQL на число параметров одного запроса (65535).
// rowCount многострочного INSERT — число РЕАЛЬНО вставленных строк (те, что
// столкнулись с ON CONFLICT DO NOTHING, в него не попадают), поэтому его
// можно суммировать в queued без отдельного пересчёта.
async function insertQueueBatch(salonId, rule, batch, clientMap) {
  if (!batch.length) return 0;
  const cols = ['salon_id', 'rule_id', 'rule_title', 'client_id', 'phone', 'yclients_client_id',
                'anchor_record_id', 'anchor_visit_at', 'anchor_staff_name', 'anchor_services',
                'scheduled_at', 'source'];
  const tuples = [];
  const params = [];
  batch.forEach((row, i) => {
    const clientId = clientMap.byYcId.get(String(row.ycClientId))
      ?? clientMap.byPhone.get(row.phone)
      ?? null;
    const base = i * cols.length;
    tuples.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},` +
                `$${base + 7},$${base + 8},$${base + 9},$${base + 10}::jsonb,$${base + 11},$${base + 12})`);
    params.push(
      salonId, rule.id, rule.title, clientId, row.phone, row.ycClientId,
      row.recordId, row.visitAt, row.staffName || null, JSON.stringify(row.services),
      row.scheduledAt, 'backfill');
  });
  const res = await db.query(
    `INSERT INTO reminder_queue (${cols.join(', ')})
     VALUES ${tuples.join(',')}
     ON CONFLICT (rule_id, anchor_record_id) DO NOTHING`,
    params);
  return (res && res.rowCount) || 0;
}

router.post('/rules/:id/backfill', guard, async (req, res) => {
  const ruleKey = req.params.id;
  // Двойной клик / два администратора: оба прогона тратили бы квоту YClients
  // вдвое и админы видели бы два разных числа. Защита ПРОЦЕССНАЯ (прод —
  // один процесс PM2 fork), не распределённая — при горизонтальном
  // масштабировании нужен отдельный механизм (в стиле _tickInFlight
  // reminders-воркера).
  if (backfillInFlight.has(ruleKey)) {
    return res.status(409).json({ error: 'Догон по этому правилу уже выполняется' });
  }
  backfillInFlight.add(ruleKey);
  const days = Math.min(90, Math.max(1, Number(req.body && req.body.days) || 30));
  let queued = 0;
  try {
    const r = await buildBackfill(req.user.salonId, ruleKey, days);
    if (r.error) return res.status(r.code).json({ error: r.error });
    const planned = planBackfillSchedule(r.out.rows.filter(x => !x.skipReason), {
      delayDays: r.rule.delay_days, sendTime: r.rule.send_time,
      maxPerDay: r.rule.backfill_max_per_day })
      .filter(row => row.scheduledAt);

    const clientMap = await resolveClients(req.user.salonId, planned);
    for (let i = 0; i < planned.length; i += BACKFILL_BATCH) {
      const batch = planned.slice(i, i + BACKFILL_BATCH);
      queued += await insertQueueBatch(req.user.salonId, r.rule, batch, clientMap);
    }
    log.info(`догон правила #${r.rule.id}: поставлено ${queued} из ${planned.length}`);
    res.json({ queued, planned: planned.length, totals: r.out.totals });
  } catch (e) {
    // Падение в середине пачки не должно скрывать, сколько строк УЖЕ легло —
    // иначе админу приходится идти в историю, чтобы понять, сработало ли.
    // Число — прямо в тексте ошибки: общий api() на фронте выбрасывает только
    // j.error, поле queued тела ответа он теряет.
    log.error(`догон правила #${ruleKey}: ${e.message} (успело встать ${queued})`);
    res.status(500).json({ error: `Не удалось выполнить догон. Успело встать в очередь: ${queued}`, queued });
  } finally {
    backfillInFlight.delete(ruleKey);
  }
});

// ── тестовая отправка на свой номер ────────────────────────────
// ЗАЧЕМ: планирование чисто событийное, у нового правила очередь пуста, а
// текст (в режиме free его пишет Мила) и ступень бонусов считаются только в
// момент отправки — до включения «в массы» проверить их иначе нечем. Строка
// гоняется ТЕМ ЖЕ воркером (worker.processTestRow), отличия — только в том,
// что тест не портит боевое состояние клиента (см. buildTestDeps).

const ANCHOR_LOOKBACK_DAYS = 365;
// Двойной клик = два реальных сообщения живому человеку.  Защита ПРОЦЕССНАЯ,
// как backfillInFlight выше.
const testInFlight = new Set();

/**
 * Карточка клиента по номеру — суффиксным LIKE, ровно как identity.resolveClient.
 * Точное сравнение с каноничным ключом (79200255591) промахивается: в базе
 * номера лежат в разных формах ('+79200255591'), и тест уходил бы без имени и,
 * что хуже, БЕЗ yclients_client_id — то есть с молча выключенными бонусами
 * (поймано живым прогоном scripts/reminders-test-send-e2e.js). Защита от
 * совпадения с хвостом ЧУЖОГО номера — та же: только полный номер (10+ цифр).
 */
async function resolveTestClient(salonId, phone) {
  if (!phone || phone.length < 10) return null;
  return db.oneOrNone(
    `SELECT id, name, yclients_client_id FROM clients
      WHERE salon_id=$1 AND phone LIKE '%' || $2 ORDER BY id LIMIT 1`, [salonId, phone]);
}

/**
 * Якорь теста — последний СОСТОЯВШИЙСЯ визит клиента ПОД УСЛОВИЯ ПРАВИЛА
 * (в бою якорь по определению прошёл evaluateRule, см. pickAnchorVisit): от
 * него считаются {дней}, {услуга}, {мастер}. Подходящих визитов нет (или
 * YClients молчит) → null, и buildTestRow возьмёт дату из задержки правила, а
 * плейсхолдеры услуги и мастера отрендерятся пустыми — администратор увидит
 * это в ответе.
 */
async function loadTestAnchor(salonId, ycId, conditions) {
  if (!ycId) return null;
  const salon = await db.oneOrNone(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);
  if (!salon || !salon.yclients_company_id) return null;
  const recs = await ycGetClientRecords(salon, ycId,
    { startDate: mskDate(new Date(Date.now() - ANCHOR_LOOKBACK_DAYS * 86400000)) });
  // Карта категорий нужна условиям вида «категория Лазерная эпиляция». Её сбой
  // не должен ронять тест: без карты условие по КАТЕГОРИИ просто не совпадёт,
  // и якоря не будет — администратор увидит это в ответе, а не 500.
  const catMap = await getServiceCategoryMap(salon).catch((e) => {
    log.warn(`тест: карта категорий недоступна (${e.message})`);
    return new Map();
  });
  return pickAnchorVisit(recs, Date.now(), { conditions, catMap });
}

router.post('/rules/:id/test', guard, async (req, res) => {
  const phone = normalizePhoneKey(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Укажите номер телефона' });
  // Неполный номер нашёл бы по суффиксу ЧУЖУЮ карточку (та же защита, что в
  // identity.resolveClient), а сообщение ушло бы неизвестно кому.
  if (phone.length < 10) return res.status(400).json({ error: 'Номер должен быть полным (11 цифр)' });
  // Начисление НЕОБРАТИМО (ручная транзакция по карте) — боевой путь бонусов
  // включается только явным согласием, по умолчанию сухой прогон.
  const accrue = !!(req.body && req.body.accrue);
  const key = `${req.params.id}:${phone}`;
  if (testInFlight.has(key)) return res.status(409).json({ error: 'Тестовая отправка уже выполняется' });
  testInFlight.add(key);
  try {
    const rule = await db.oneOrNone(
      `SELECT id, salon_id, title, delay_days, bonus_enabled, conditions FROM reminder_rules
        WHERE id=$1 AND salon_id=$2`, [req.params.id, req.user.salonId]);
    if (!rule) return res.status(404).json({ error: 'Правило не найдено' });

    const client = await resolveTestClient(req.user.salonId, phone);
    // id клиента YClients нужен И якорю (история визитов), И бонусам — резолвим
    // один раз: в карточке поле заполнено не всегда, запасной путь — по истории
    // записей (identity.resolveYclientsClientId).
    const ycClientId = (client && client.yclients_client_id)
      || await identity.resolveYclientsClientId(req.user.salonId, phone).catch(() => null);

    let anchor = null;
    let anchorFailed = false;
    try { anchor = await loadTestAnchor(req.user.salonId, ycClientId, rule.conditions); }
    catch (e) {
      anchorFailed = true;
      log.warn(`тест правила #${rule.id}: визиты клиента недоступны (${e.message})`);
    }

    const v = buildTestRow({ rule, client, phone, anchor, ycClientId });
    const row = await db.oneOrNone(
      `INSERT INTO reminder_queue
         (salon_id, rule_id, rule_title, client_id, phone, yclients_client_id,
          anchor_record_id, anchor_visit_at, anchor_staff_name, anchor_services,
          scheduled_at, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
       RETURNING id`,
      [v.salon_id, v.rule_id, v.rule_title, v.client_id, v.phone, v.yclients_client_id,
       v.anchor_record_id, v.anchor_visit_at, v.anchor_staff_name,
       JSON.stringify(v.anchor_services), v.scheduled_at, v.source]);
    if (!row) throw new Error('строка тестовой отправки не создалась');

    await remindersWorker.processTestRow(row.id, { accrue });

    const after = await db.oneOrNone(
      `SELECT status, decision_reason, rendered_text, channel_used, error,
              balance_before, bonus_tier, bonus_accrued, bonus_txn_ok
         FROM reminder_queue WHERE id=$1`, [row.id]);
    log.info(`тест правила #${rule.id} на ${phone}: ${after && after.status} (${after && after.decision_reason})`);
    res.json({
      queueId: row.id,
      status: after ? after.status : null,
      reason: after ? after.decision_reason : null,
      error: after ? after.error : null,
      text: after ? after.rendered_text : null,
      channel: after ? after.channel_used : null,
      bonus: {
        enabled: !!rule.bonus_enabled,
        dryRun: !accrue,
        balanceBefore: after ? after.balance_before : null,
        tier: after ? after.bonus_tier : null,
        accrued: after ? after.bonus_accrued : null,
        txnOk: after ? after.bonus_txn_ok : null,
      },
      clientFound: !!client,
      clientName: client ? client.name : null,
      anchorFailed,
      anchor: anchor ? {
        visitAt: anchor.visitAt,
        staffName: anchor.staffName,
        services: anchor.services.map(s => ({ id: s && s.id, title: s && s.title })),
      } : null,
    });
  } catch (e) {
    log.error(`тест правила #${req.params.id}: ${e.message}`);
    res.status(500).json({ error: 'Не удалось выполнить тестовую отправку' });
  } finally {
    testInFlight.delete(key);
  }
});

const QUEUE_COLUMNS = `
  q.id, q.rule_id AS "ruleId", q.rule_title AS "ruleTitle", q.phone,
  q.scheduled_at AS "scheduledAt", q.status, q.decision_reason AS "reason",
  q.rendered_text AS "text", q.sent_at AS "sentAt", q.channel_used AS "channel",
  q.balance_before AS "balanceBefore", q.bonus_tier AS "bonusTier",
  q.bonus_accrued AS "bonusAccrued", q.bonus_txn_ok AS "bonusTxnOk",
  q.conversion_record_id AS "conversionRecordId", q.converted_at AS "convertedAt",
  q.visited_at AS "visitedAt", q.source, q.anchor_services AS "anchorServices",
  q.anchor_visit_at AS "anchorVisitAt", c.name AS "clientName",
  EXISTS (SELECT 1 FROM reminder_suppressions s
           WHERE s.rule_id = q.rule_id AND s.phone = q.phone AND s.muted = TRUE) AS "muted"`;

// Отдельной вкладки «очередь» нет: запланированные строки видны в истории по
// фильтру статуса «Запланировано», оттуда же их можно отменить.
router.post('/queue/:id/cancel', guard, async (req, res) => {
  try {
    const row = await db.oneOrNone(
      `UPDATE reminder_queue SET status='cancelled', decision_reason='отменено вручную'
        WHERE id=$1 AND salon_id=$2 AND status='scheduled' RETURNING id`,
      [req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Строка не найдена или уже обработана' });
    res.json({ ok: true });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Не удалось отменить' }); }
});

router.get('/history', guard, async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const ruleId = req.query.ruleId ? Number(req.query.ruleId) : null;
  const status = req.query.status || null;
  const converted = req.query.converted === '1' ? true : (req.query.converted === '0' ? false : null);
  try {
    const rows = await db.any(
      `SELECT ${QUEUE_COLUMNS}
         FROM reminder_queue q LEFT JOIN clients c ON c.id = q.client_id
        WHERE q.salon_id = $1
          AND ($2::int  IS NULL OR q.rule_id = $2)
          AND ($3::text IS NULL OR q.status  = $3)
          AND ($4::bool IS NULL OR (q.conversion_record_id IS NOT NULL) = $4)
        ORDER BY COALESCE(q.sent_at, q.scheduled_at) DESC
        LIMIT $5 OFFSET $6`,
      [req.user.salonId, ruleId, status, converted, limit, offset]);
    res.json({ rows, limit, offset });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Не удалось загрузить историю' }); }
});

// Ручной тумблер анти-повтора по паре клиент+правило.
router.post('/suppressions/toggle', guard, async (req, res) => {
  const ruleId = Number(req.body && req.body.ruleId);
  const phone = normalizePhoneKey(req.body && req.body.phone);
  const muted = !!(req.body && req.body.muted);
  if (!Number.isFinite(ruleId) || !phone) return res.status(400).json({ error: 'Нужны ruleId и phone' });
  try {
    const rule = await db.oneOrNone(
      `SELECT id FROM reminder_rules WHERE id=$1 AND salon_id=$2`, [ruleId, req.user.salonId]);
    if (!rule) return res.status(404).json({ error: 'Правило не найдено' });
    await db.query(
      `INSERT INTO reminder_suppressions (salon_id, rule_id, phone, muted, reason, source, muted_at, reset_at, updated_at)
       VALUES ($1,$2,$3,$4,'изменено вручную','manual',
               CASE WHEN $4 THEN NOW() END, CASE WHEN $4 THEN NULL ELSE NOW() END, NOW())
       ON CONFLICT (rule_id, phone) DO UPDATE
         SET muted=$4, reason='изменено вручную', source='manual',
             muted_at = CASE WHEN $4 THEN NOW() ELSE reminder_suppressions.muted_at END,
             reset_at = CASE WHEN $4 THEN NULL ELSE NOW() END,
             updated_at = NOW()`,
      [req.user.salonId, ruleId, phone, muted]);
    res.json({ ok: true, muted });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Не удалось изменить флаг' }); }
});

module.exports = router;
// parseRuleBody вынесена наружу ради теста (reminders-routes.test.js) — сам
// роутер прямых тестов в проекте не имеет (как и routes/care.js), но
// валидация тела правила чистая и легко проверяется без HTTP/БД. Не меняет
// поведение маршрутов: router — тот же объект, что и раньше, со свойством.
module.exports.parseRuleBody = parseRuleBody;
// Тем же приёмом наружу вынесены резолверы тестовой отправки: живой прогон
// scripts/reminders-test-send-e2e.js обязан ходить по ТОМУ ЖЕ коду, что и
// ручка, — второй копии правила «как искать карточку по номеру» быть не должно
// (именно на нём и поймали промах точного сравнения телефонов).
module.exports.resolveTestClient = resolveTestClient;
module.exports.loadTestAnchor = loadTestAnchor;
// Тем же приёмом наружу вынесена сводка плана догона (превью): maxAt/whenBy
// появились как реакция на готчу «порядок planned НЕ гарантирует возрастания
// scheduledAt» — ровно то место, где регресс легко внести и невозможно
// заметить без юнит-теста.
module.exports.summarizeBackfillPlan = summarizeBackfillPlan;
