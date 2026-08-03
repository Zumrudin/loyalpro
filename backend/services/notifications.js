// ============================================================
// Автоуведомления по событиям (v1: создание записи)
// ============================================================
//
// Правила живут в notification_rules (условия по специалисту/категории/услугам,
// объединяемые И или ИЛИ). Вебхук YClients при status='create' зовёт
// handleRecordCreated: правила дёшево оцениваются в памяти, совпавшие кладут
// строку в notification_sends (очередь+журнал, дедуп UNIQUE (rule_id, record_id)).
//
// Отправляет отдельный воркер (startNotificationWorker, по образцу
// broadcast-воркера): выбирает pending, определяет каскад каналов Chatpush и
// шлёт через sendMessage. Канал по умолчанию — тот, откуда клиент писал в
// последний раз (chatpush_messages, direction='incoming'); если клиент не
// писал — каскад из правила как настроен.
//
// Категорий в payload записи нет (только services[].id) — маппинг
// serviceId → categoryId строится из booking-каталога YClients (полный список,
// без фильтра по цене) и кэшируется в памяти.

const { db } = require('../db');
const config = require('../config');
const chatpush = require('./chatpush');
const { normalizePhoneKey } = require('./agent-gate');
const { ycGet } = require('./yclients');
const { createLogger } = require('../logger');

const log = createLogger('Notifications');

const WORKER_TICK_MS   = 3000;
const MAX_ATTEMPTS     = 3;
const RETRY_BACKOFF_S  = 60;   // пауза между попытками одной строки

// Значения dispatch_routing Chatpush, которые разрешаем в правиле.
const ALLOWED_CHANNELS = ['telegram', 'whatsapp', 'tdlib', 'max', 'max_bot', 'notify'];

// ── чистая часть (юнит-тесты без БД) ───────────────────────────

/**
 * Оценить условия правила против контекста записи.
 * conditions = { logic:'and'|'or', items:[{type:'staff'|'category'|'service', ids:[…]}] }
 * ctx = { staffId, serviceIds:[], categoryIds:[] } (все id — числа или строки)
 * Пустой items ⇒ true (правило на любую запись). Внутри условия — ИЛИ по ids.
 */
function evaluateRule(conditions, ctx) {
  const items = Array.isArray(conditions && conditions.items) ? conditions.items : [];
  if (!items.length) return true;
  const logic = conditions.logic === 'or' ? 'or' : 'and';

  const has = (list, ids) => {
    const set = new Set((ids || []).map(String));
    return (list || []).some(v => set.has(String(v)));
  };
  const results = items.map(it => {
    if (!it || !Array.isArray(it.ids) || !it.ids.length) return true; // пустое условие не ограничивает
    switch (it.type) {
      case 'staff':    return has([ctx.staffId], it.ids);
      case 'category': return has(ctx.categoryIds, it.ids);
      case 'service':  return has(ctx.serviceIds, it.ids);
      default:         return false; // неизвестный тип условия не должен «пропускать всё»
    }
  });
  return logic === 'or' ? results.some(Boolean) : results.every(Boolean);
}

/**
 * Подстановки шаблона: {name} {first_name} {date} {time} {services} {staff} {salon}
 * ctx: { name, date:'ДД.ММ.ГГГГ', time:'ЧЧ:ММ', services:'A, B', staff, salon }
 */
function renderTemplate(text, ctx) {
  if (!text) return '';
  const firstName = (ctx.name || '').trim().split(/\s+/)[0] || '';
  return String(text)
    .replace(/\{name\}/g,       ctx.name || '')
    .replace(/\{first_name\}/g, firstName)
    .replace(/\{date\}/g,       ctx.date || '')
    .replace(/\{time\}/g,       ctx.time || '')
    .replace(/\{services\}/g,   ctx.services || '')
    .replace(/\{staff\}/g,      ctx.staff || '')
    .replace(/\{salon\}/g,      ctx.salon || '');
}

/** '2026-08-02 14:00:00' → { date:'02.08.2026', time:'14:00' } (строка YClients уже салон-локальная). */
function splitVisitDatetime(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return { date: '', time: '' };
  return { date: `${m[3]}.${m[2]}.${m[1]}`, time: `${m[4]}:${m[5]}` };
}

/**
 * Каскад каналов для отправки: последний входящий канал клиента (если известен и
 * prefer_last_channel) ставится первым, остальные каналы правила — следом как
 * страховка. Неизвестные значения отбрасываются.
 */
function resolveRouting(ruleChannels, preferLastChannel, lastChannel) {
  const base = (Array.isArray(ruleChannels) ? ruleChannels : [])
    .filter(c => ALLOWED_CHANNELS.includes(c));
  const routing = base.length ? base : ['telegram', 'whatsapp'];
  if (preferLastChannel && lastChannel && ALLOWED_CHANNELS.includes(lastChannel)) {
    return [lastChannel, ...routing.filter(c => c !== lastChannel)];
  }
  return routing;
}

// ── маппинг услуга → категория (кэш) ───────────────────────────

const _catMapCache = {};             // salonId → { ts, map: Map<serviceIdStr, categoryIdStr> }
const CAT_MAP_TTL = 10 * 60 * 1000;

async function getServiceCategoryMap(salon) {
  const cached = _catMapCache[salon.id];
  if (cached && Date.now() - cached.ts < CAT_MAP_TTL) return cached.map;
  const cid = salon.yclients_company_id;
  const map = new Map();
  if (cid) {
    const raw = await ycGet(salon, `/services/${cid}`).catch(() => null);
    for (const s of (Array.isArray(raw) ? raw : [])) {
      if (s && s.id != null && s.category_id != null) map.set(String(s.id), String(s.category_id));
    }
  }
  if (map.size) _catMapCache[salon.id] = { ts: Date.now(), map }; // сбой каталога не кэшируем
  return map;
}

// ── обработка события «создание записи» ────────────────────────

/**
 * Вызывается из routes/webhook.js после processRecordEvent, только при
 * payload.status === 'create'. Своя обработка ошибок у вызывающего —
 * сбой уведомлений не должен ломать начисление кэшбэка.
 */
async function handleRecordCreated(salon, payload) {
  const data = payload.data || {};
  const ycRecordId = data.id;
  if (!ycRecordId) return;

  const rules = await db.any(
    `SELECT * FROM notification_rules
      WHERE salon_id = $1 AND is_enabled = TRUE AND trigger_type = 'record_created'`,
    [salon.id]
  );
  if (!rules.length) return;

  const serviceIds = (Array.isArray(data.services) ? data.services : [])
    .map(s => s && s.id).filter(v => v != null);
  const catMap = await getServiceCategoryMap(salon).catch(() => new Map());
  const ctx = {
    staffId:     data.staff && data.staff.id != null ? data.staff.id : null,
    serviceIds,
    categoryIds: [...new Set(serviceIds.map(id => catMap.get(String(id))).filter(Boolean))],
  };

  const matched = rules.filter(r => {
    try { return evaluateRule(r.conditions, ctx); }
    catch (e) { log.warn(`rule #${r.id} evaluate failed: ${e.message}`); return false; }
  });
  if (!matched.length) return;

  const phone = normalizePhoneKey(data.client && data.client.phone);
  const client = await db.oneOrNone(
    `SELECT id, name, is_blacklisted FROM clients
      WHERE salon_id = $1 AND yclients_client_id = $2`,
    [salon.id, data.client && data.client.id]
  );

  // Причина пропуска фиксируется в журнале — иначе «почему не пришло» не разобрать.
  let skipReason = null;
  if (!phone) skipReason = 'нет телефона клиента';
  else if (client && client.is_blacklisted) skipReason = 'клиент в чёрном списке';

  const dt = splitVisitDatetime(data.date);
  const renderCtx = {
    name:     (client && client.name) || (data.client && data.client.name) || '',
    date:     dt.date,
    time:     dt.time,
    services: (Array.isArray(data.services) ? data.services : []).map(s => s && s.title).filter(Boolean).join(', '),
    staff:    (data.staff && data.staff.name) || '',
    salon:    salon.name || '',
  };

  for (const r of matched) {
    const res = await db.query(
      `INSERT INTO notification_sends
         (salon_id, rule_id, yclients_record_id, client_id, phone, status, error, rendered_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (rule_id, yclients_record_id) DO NOTHING`,
      [salon.id, r.id, ycRecordId, client ? client.id : null, phone || null,
       skipReason ? 'skipped' : 'pending', skipReason,
       renderTemplate(r.message_template, renderCtx)]
    );
    if (res.rowCount) {
      log.info(`rule #${r.id} matched record=${ycRecordId} → ${skipReason ? 'skipped: ' + skipReason : 'queued'}`);
    }
  }
}

// ── воркер отправки ────────────────────────────────────────────

/** Последний канал, из которого клиент нам писал (значение dispatch_routing) или null. */
async function lastIncomingChannel(salonId, phone) {
  const row = await db.oneOrNone(
    `SELECT channel FROM chatpush_messages
      WHERE salon_id = $1 AND phone = $2 AND direction = 'incoming'
      ORDER BY msg_ts DESC NULLS LAST
      LIMIT 1`,
    [salonId, phone]
  );
  return row ? chatpush.replyRoutingFor(row.channel) : null;
}

async function processTick() {
  // Атомарная «аренда» пачки: attempts и last_attempt_at проставляются сразу,
  // так что упавший посреди отправки процесс не даст мгновенного повтора —
  // строка вернётся в выборку только после бэкоффа.
  const rows = await db.any(
    `UPDATE notification_sends ns
        SET attempts = ns.attempts + 1, last_attempt_at = NOW()
       FROM notification_rules r
      WHERE r.id = ns.rule_id
        AND ns.id IN (
          SELECT id FROM notification_sends
           WHERE status = 'pending'
             AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - make_interval(secs => $1))
           ORDER BY id ASC
           LIMIT 10
           FOR UPDATE SKIP LOCKED
        )
      RETURNING ns.*, r.channels, r.prefer_last_channel`,
    [RETRY_BACKOFF_S]
  );

  for (const row of rows) {
    try {
      const last = await lastIncomingChannel(row.salon_id, row.phone).catch(() => null);
      const routing = resolveRouting(row.channels, row.prefer_last_channel, last);
      const delivery = await chatpush.sendMessage(config.CHATPUSH.instanceToken, {
        text: row.rendered_text,
        phone: row.phone,
        dispatchRouting: routing,
      });
      await db.query(
        `UPDATE notification_sends
            SET status='sent', sent_at=NOW(), error=NULL,
                routing=$2::jsonb, delivery_id=$3, channel_used=$4
          WHERE id=$1`,
        [row.id, JSON.stringify(routing),
         delivery && delivery.id != null ? String(delivery.id) : null,
         (delivery && (delivery.channel || delivery.messenger)) || routing[0] || null]
      );
      log.info(`sent #${row.id} rule=${row.rule_id} record=${row.yclients_record_id} routing=[${routing.join(',')}]`);
    } catch (e) {
      // attempts уже инкрементирован при аренде — row.attempts актуален.
      const final = row.attempts >= MAX_ATTEMPTS;
      await db.query(
        `UPDATE notification_sends SET status=$2, error=$3 WHERE id=$1`,
        [row.id, final ? 'failed' : 'pending', String(e.message || e).slice(0, 500)]
      ).catch(() => {});
      log.warn(`send #${row.id} attempt ${row.attempts}/${MAX_ATTEMPTS} failed: ${e.message}`);
    }
  }
}

let _workerRunning = false;
function startNotificationWorker() {
  if (_workerRunning) return;
  _workerRunning = true;
  if (!config.CHATPUSH.instanceToken) {
    log.warn('CHATPUSH_INSTANCE_TOKEN is not set — notification worker disabled');
    return;
  }
  setInterval(() => {
    processTick().catch(e => log.error(`worker tick: ${e.message}`));
  }, WORKER_TICK_MS);
  log.info(`Notification worker started (tick=${WORKER_TICK_MS}ms)`);
}

module.exports = {
  handleRecordCreated,
  startNotificationWorker,
  ALLOWED_CHANNELS,
  // чистые хелперы — для роутов и тестов
  evaluateRule,
  renderTemplate,
  resolveRouting,
  splitVisitDatetime,
  // переиспользуются «Отделом заботы»
  getServiceCategoryMap,
  lastIncomingChannel,
  _lastIncomingChannel: lastIncomingChannel,
};
