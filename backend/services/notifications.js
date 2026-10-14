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
// ФАСАД. Чистые помощники переехали в services/notifications/ и ре-экспортируются
// отсюда под ПРЕЖНИМИ именами — на них завязаны «Забота», напоминания, followup
// Милы, роуты и server.js:
//   rules.js  — evaluateRule, resolveRouting, ALLOWED_CHANNELS, splitVisitDatetime,
//               getServiceCategoryMap (категорий в payload записи нет — только
//               services[].id, маппинг строится из каталога YClients), lastIncomingChannel;
//   render.js — renderTemplate.
// Здесь остаются v1-обработчик handleRecordCreated и воркер отправки.

const { db } = require('../db');
const config = require('../config');
const transport = require('./messaging/transport');
const { normalizePhoneKey } = require('./agent-gate');
const { persistWhatsappOutgoing } = require('./chat-persist');
const pendingReplies = require('./agent/pending-replies');
const authorship = require('./outgoing-authorship');
const salonNames = require('../utils/salon-names');
const { createLogger } = require('../logger');

// Без промежуточных `rules`/`render`: локальная `const rules` (строки из БД) в
// handleRecordCreated затеняла бы одноимённый модуль.
const {
  evaluateRule, resolveRouting, ALLOWED_CHANNELS, getServiceCategoryMap, lastIncomingChannel, splitVisitDatetime,
} = require('./notifications/rules');
const { renderTemplate } = require('./notifications/render');

const log = createLogger('Notifications');

const WORKER_TICK_MS   = 3000;
const MAX_ATTEMPTS     = 3;
const RETRY_BACKOFF_S  = 60;   // пауза между попытками одной строки

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
    // Словарь имён салона — чтобы редкое имя из карточки попало в {first_name},
    // а не потерялось. Недоступен → работает базовый список (fail-open).
    nameDictionary: await salonNames.load(salon.id).catch(() => null),
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
      const delivery = await transport.sendMessage(row.salon_id, {
        text: row.rendered_text,
        phone: row.phone,
        dispatchRouting: routing,
      });
      // delivery.channels — каналы ТОГО аккаунта, через который transport реально отправил
      // (при фолбэке на другой аккаунт routing[0] был бы неверен).
      const channelUsed = (delivery && (delivery.channel || delivery.messenger))
        || (delivery && Array.isArray(delivery.channels) && delivery.channels[0]) || routing[0] || null;
      await db.query(
        `UPDATE notification_sends
            SET status='sent', sent_at=NOW(), error=NULL,
                routing=$2::jsonb, delivery_id=$3, channel_used=$4
          WHERE id=$1`,
        [row.id, JSON.stringify(routing),
         delivery && delivery.id != null ? String(delivery.id) : null,
         channelUsed]
      );
      log.info(`sent #${row.id} rule=${row.rule_id} record=${row.yclients_record_id} routing=[${routing.join(',')}]`);
      // Транскрипт Милы собирается из chatpush_messages, куда исходящее
      // попадает только с эхом Chatpush: tdlib/max его шлют с задержкой,
      // WhatsApp — не шлёт вовсе. Без этих двух шагов пациент, ответивший на
      // уведомление («+», «да, расскажите»), приходил к Миле без текста, НА
      // который он отвечает. Та же схема, что у «Отдела заботы»
      // (services/care/worker.js): pending до эха + персист для WhatsApp.
      // Оба шага — best-effort и НИКОГДА не бросают наружу: строка уже
      // помечена sent, а падение сюда увело бы её в общий catch и вернуло в
      // pending → повторная отправка живому клиенту.
      try {
        pendingReplies.remember(row.salon_id, row.phone, row.rendered_text);
      } catch (e) { log.error(`pending #${row.id}: ${e.message}`); }
      // Автоуведомление — НАШЕ сообщение: без этой отметки его эхо выглядит как
      // ответ живого администратора и поставило бы Милу на паузу.
      await authorship.remember(row.salon_id, row.phone, row.rendered_text, 'system');
      if (channelUsed === 'whatsapp') {
        await persistWhatsappOutgoing(row.salon_id, {
          delivery, phone: row.phone, chatId: null,
          text: row.rendered_text, msgType: 'text',
        }).catch(e => log.error(`persist wa #${row.id}: ${e.message}`));
      }
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
  if (!transport.configured()) {
    log.warn('ни CHATPUSH_INSTANCE_TOKEN, ни MESSAGING_GATEWAY_URL не заданы — notification worker disabled');
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
