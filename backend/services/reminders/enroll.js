'use strict';
// Планирование напоминаний о повторном визите и атрибуция конверсии.
// Зовётся из routes/webhook.js на resource='record', в собственном try/catch:
// падение напоминаний не должно ронять «Заботу» и начисление кэшбэка.
//
// Планирование ЧИСТО СОБЫТИЙНОЕ — бэкфилла нет, для догона по базе есть
// отдельная ручка (services/reminders/preview.js + routes/reminders.js).
//
// Критерий «визит состоялся» и классификация события — те же, что у «Заботы»
// (care/enroll.js): attendance=1 ИЛИ paid_full=1, а отмена/неявка проверяется
// ПЕРВОЙ, потому что предоплаченная неявка несёт paid_full=1 одновременно с
// attendance=-1.

const { db: realDb } = require('../../db');
const { evaluateRule, getServiceCategoryMap } = require('../notifications');
const { normalizePhoneKey } = require('../agent-gate');
const { parseVisitAt, computeScheduledAt } = require('../care/schedule');
const { isVisitCompleted, classifyRecordEvent } = require('../care/enroll');
const { recordContext } = require('./eligibility');
const { pickAttributionRow } = require('./attribution');
const { createLogger } = require('../../logger');

const defaultDeps = {
  db: realDb,
  getCatMap: (salon) => getServiceCategoryMap(salon),
  log: createLogger('Reminders'),
};

/**
 * Визит ДЕЙСТВИТЕЛЬНО состоялся? Голого isVisitCompleted() тут мало: у
 * предоплаченной неявки paid_full=1 стоит ОДНОВРЕМЕННО с attendance=-1
 * (депозит удержан, клиент не пришёл) — isVisitCompleted() наивно вернул бы
 * true. classifyRecordEvent распознаёт неявку/отмену ПЕРВОЙ (тот же
 * приоритет, что в handleRecordEvent и в «Заботе»); без него в дашборде
 * правила «дошли» засчитался бы визит, которого не было, — прямая
 * фальсификация KPI, на который смотрит владелец салона.
 */
function visitReallyHappened(data, payloadStatus) {
  return isVisitCompleted(data) && classifyRecordEvent(data, payloadStatus) !== 'unenroll';
}

/** Отменить запланированные строки конкретной записи (отмена/неявка). */
async function cancelForRecord(db, salonId, recordId, reason) {
  await db.query(
    `UPDATE reminder_queue
        SET status = 'cancelled', decision_reason = $3
      WHERE salon_id = $1 AND anchor_record_id = $2 AND status = 'scheduled'`,
    [salonId, recordId, reason]);
}

async function handleRecordEvent(salon, payload, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  const { db, log } = d;
  const data = (payload && payload.data) || {};
  if (!data.id) return;

  const kind = classifyRecordEvent(data, payload && payload.status);
  if (kind === 'unenroll') {
    await cancelForRecord(db, salon.id, data.id, 'запись отменена/неявка');
    return;
  }
  if (kind !== 'enroll') return;

  const rules = await db.any(
    `SELECT * FROM reminder_rules WHERE salon_id = $1 AND is_enabled = TRUE`,
    [salon.id]);
  if (!rules.length) return;

  const phone = normalizePhoneKey(data.client && data.client.phone);
  if (!phone) { log.info(`record=${data.id}: нет телефона — напоминание невозможно`); return; }

  const catMap = await d.getCatMap(salon).catch(() => new Map());
  const ctx = recordContext(data, catMap);
  const matched = rules.filter(r => {
    try { return evaluateRule(r.conditions, ctx); }
    catch (e) { log.warn(`rule #${r.id} evaluate failed: ${e.message}`); return false; }
  });
  if (!matched.length) return;

  // Фолбэк по телефону — как в care/enroll.js: несинкнутый клиент не должен
  // проскочить мимо чёрного списка.
  const client = await db.oneOrNone(
    `SELECT id, name, is_blacklisted FROM clients
      WHERE salon_id = $1 AND (yclients_client_id = $2 OR phone = $3)
      ORDER BY (yclients_client_id = $2) DESC NULLS LAST
      LIMIT 1`,
    [salon.id, data.client && data.client.id, phone]);
  if (client && client.is_blacklisted) {
    log.info(`record=${data.id}: клиент в ЧС — напоминания не планируем`); return;
  }

  const visitAt = parseVisitAt(data.date);
  const services = (Array.isArray(data.services) ? data.services : [])
    .map(s => ({ id: s && s.id, title: s && s.title })).filter(s => s.title);

  for (const rule of matched) {
    // 0) Симметричная защита от вебхука, пришедшего НЕ ПО ПОРЯДКУ: если по
    //    этому же правилу и телефону уже есть ЖИВАЯ (scheduled) строка от
    //    БОЛЕЕ ПОЗДНЕГО визита (ретрай YClients / правка задним числом
    //    обработались вне очереди), планировать по этому, более старому,
    //    визиту нечего — иначе клиента дёрнут дважды. Без даты визита
    //    сравнение невозможно — пропускаем защиту (симметрично условию в
    //    cancel-stale блоке ниже) и полагаемся на дедуп по anchor_record_id.
    //    Проверка идёт ПЕРВОЙ: ни un-mute, ни cancel-stale, ни INSERT для
    //    этого правила выполняться не должны (тот же приём, что в
    //    care/enroll.js — «более поздний активный enrollment уже есть»).
    if (visitAt) {
      const later = await db.oneOrNone(
        `SELECT id FROM reminder_queue
          WHERE salon_id = $1 AND rule_id = $2 AND phone = $3
            AND status = 'scheduled' AND anchor_visit_at > $4
          LIMIT 1`,
        [salon.id, rule.id, phone, visitAt]);
      if (later) {
        log.info(`rule #${rule.id}: пропуск — уже есть напоминание #${later.id} от более позднего визита`);
        continue;
      }
    }

    // 1) Клиент дошёл — снимаем флаг анти-повтора. ДО планирования: иначе новая
    //    строка упрётся в собственный muted от прошлого цикла (гейт воркера
    //    читает suppressions в момент отправки). ТОЛЬКО source='auto' —
    //    ручной отказ (администратор осознанно отписал клиента от этого
    //    правила, тумблер в Task 12) визитом не отменяется, снять его может
    //    только человек.
    await db.query(
      `UPDATE reminder_suppressions
          SET muted = FALSE, reset_at = NOW(), updated_at = NOW(),
              reason = 'клиент пришёл на визит'
        WHERE rule_id = $1 AND phone = $2 AND muted = TRUE AND source = 'auto'`,
      [rule.id, phone]);

    // 2) Прежние запланированные строки от БОЛЕЕ РАННИХ визитов устарели.
    //    Условие по anchor_visit_at обязательно: правка старой записи может
    //    перевыстрелить вебхук годы спустя и погасила бы живое напоминание
    //    от актуального визита (тот же урок, что в care/enroll.js).
    if (visitAt) {
      await db.query(
        `UPDATE reminder_queue
            SET status = 'cancelled', decision_reason = 'новый визит перепланировал напоминание'
          WHERE salon_id = $1 AND rule_id = $2 AND phone = $3
            AND status = 'scheduled' AND anchor_record_id <> $4
            AND (anchor_visit_at IS NULL OR anchor_visit_at < $5)`,
        [salon.id, rule.id, phone, data.id, visitAt]);
    }

    // 3) Планируем. ON CONFLICT — дедуп ретраев вебхука.
    const at = computeScheduledAt(visitAt || new Date(), rule.delay_days, rule.send_time);
    if (!at) {
      log.warn(`rule #${rule.id}: computeScheduledAt вернул null (delay_days=${rule.delay_days}, send_time=${rule.send_time}) — напоминание пропущено`);
      continue;
    }
    await db.query(
      `INSERT INTO reminder_queue
         (salon_id, rule_id, rule_title, client_id, phone, yclients_client_id,
          anchor_record_id, anchor_visit_at, anchor_staff_name, anchor_services,
          scheduled_at, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,'webhook')
       ON CONFLICT (rule_id, anchor_record_id) DO NOTHING`,
      [salon.id, rule.id, rule.title, client ? client.id : null, phone,
       (data.client && data.client.id) || null, data.id, visitAt ? visitAt.toISOString() : null,
       (data.staff && data.staff.name) || null, JSON.stringify(services), at]);
    log.info(`rule #${rule.id} «${rule.title}»: напоминание record=${data.id} на ${at.toISOString()}`);
  }
}

/**
 * Атрибуция: клиент создал запись — засчитать её отправленному напоминанию;
 * визит по уже засчитанной записи состоялся — проставить visited_at.
 * Отдельная функция, потому что зовётся на ЛЮБОМ событии записи, а не только
 * на состоявшемся визите.
 */
async function handleAttribution(salon, payload, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  const { db, log } = d;
  const data = (payload && payload.data) || {};
  if (!data.id) return;

  // Визит по приведённой записи состоялся — размечаем «дошёл». Не на
  // status='create': на этот момент ни у одной строки ещё не может стоять
  // conversion_record_id = data.id (его проставляет только атрибуция ниже, и
  // именно в ЭТОМ вызове) — UPDATE был бы заведомо пустым, а его SQL-текст
  // совпал бы с регекспом `conversion_record_id` в тесте на сам факт
  // атрибуции, задвоив счётчик. Случай «создана уже состоявшейся» (walk-in
  // / запись задним числом с status='create' и attendance=1/paid_full=1
  // сразу) не теряется — он закрыт третьим параметром UPDATE'а атрибуции
  // ниже.
  if (payload && payload.status !== 'create' && visitReallyHappened(data, payload.status)) {
    await db.query(
      `UPDATE reminder_queue SET visited_at = NOW()
        WHERE salon_id = $1 AND conversion_record_id = $2 AND visited_at IS NULL`,
      [salon.id, data.id]);
  }
  if (payload && payload.status === 'delete') return;

  const phone = normalizePhoneKey(data.client && data.client.phone);
  if (!phone) return;

  // Кандидаты: отправленные напоминания клиента без отметки конверсии.
  // Окно и условия проверяет чистый pickAttributionRow — LIMIT здесь только
  // чтобы не тянуть годовую историю.
  const rows = await db.any(
    `SELECT q.id, q.rule_id, q.sent_at, q.conversion_record_id,
            r.conditions, r.attribution_days
       FROM reminder_queue q
       JOIN reminder_rules r ON r.id = q.rule_id
      WHERE q.salon_id = $1 AND q.phone = $2 AND q.status = 'sent'
        AND q.conversion_record_id IS NULL
      ORDER BY q.sent_at DESC
      LIMIT 20`,
    [salon.id, phone]);
  if (!rows.length) return;

  const catMap = await d.getCatMap(salon).catch(() => new Map());
  const win = pickAttributionRow(rows, data, catMap, Date.now());
  if (!win) return;

  await db.query(
    `UPDATE reminder_queue
        SET conversion_record_id = $2, converted_at = NOW(),
            -- визит уже состоялся в момент атрибуции (walk-in / запись задним
            -- числом): отметить «дошёл» больше будет негде — отдельный UPDATE
            -- visited_at на status='create' не выполняется (см. гейт выше).
            visited_at = CASE WHEN $3 THEN NOW() ELSE visited_at END
      WHERE id = $1 AND conversion_record_id IS NULL`,
    [win.id, data.id, visitReallyHappened(data, payload && payload.status)]);
  log.info(`конверсия: напоминание #${win.id} привело запись ${data.id}`);
}

module.exports = { handleRecordEvent, handleAttribution, cancelForRecord, defaultDeps };
