'use strict';
// ============================================================
// Сторож доставки реплик Милы.
//
// ЗАЧЕМ. `chatpush.sendMessage` возвращает `meta.status=success` в момент, когда
// Chatpush ПРИНЯЛ доставку в очередь, а не когда мессенджер её отправил. Инцидент
// 2026-08-09 (79773115566, whatsapp): клиент спросил прайс в 00:40, Мила в 00:41
// сформировала ответ, Chatpush ответил success — и дальше НИЧЕГО: ни события
// `message_status` (`sent`/`received`/`read`), ни эха. Клиент остался без ответа,
// а система считала ход успешным. По логам за 05–09.08 это 1 случай из 50 —
// то есть редкий, но молчаливый и ничем не ловившийся.
//
// КАК ЛОВИМ. Каждая отправка пишется в `agent_reply_deliveries` (`record`), а
// проход-сторож (крон в server.js) ищет подтверждение по `delivery_id` в СЫРЫХ
// событиях `chatpush_events`: его кладут туда и статусы доставки, и эхо во всех
// трёх каналах. Подтверждения нет дольше порога → ОДИН повтор отправки, и если
// не подтвердился и он — диалог переводится на администратора.
//
// ПОЧЕМУ ИМЕННО ОДИН ПОВТОР (решение владельца салона 09.08.2026). Повтор — это
// риск дубля: Chatpush мог доставить сообщение и потерять статус, тогда клиент
// прочитает один текст дважды. Размен принят сознательно — молчание в ответ на
// вопрос дороже повтора. Но риск ограничен ровно одной попыткой: вторая строка
// (`retry_of` заполнен) уже не переотправляется никогда, а уходит к человеку.
//
// ЧЕГО СТОРОЖ НЕ ДЕЛАЕТ. Он НЕ шлёт клиенту страховочную фразу «передаю
// администратору»: сломана ровно отправка, и ещё одно сообщение в ту же дыру
// ничего не даст. Перевод виден человеку в «Чате» (красный, вверху списка).
// ============================================================
const configDefault = require('../../config');
const chatpush = require('../chatpush');
const escalateTool = require('./tools/escalate-to-operator');
const { createLogger } = require('../../logger');
const logger = createLogger('AgentDeliveryWatchdog');

// Строку старше этого возраста НЕ переотправляем: процесс мог лежать часами
// (pm2 restart, OOM), и ответ на утренний вопрос, пришедший к вечеру, хуже
// молчания. Такая строка сразу уходит к человеку — клиент-то без ответа.
const MAX_RETRY_AGE_MIN = 60;
// За один тик берём ограниченную пачку: сторож фоновый, ему некуда спешить.
const BATCH = 50;

// ── Чистая часть ────────────────────────────────────────────
// Решение по ОДНОЙ строке журнала. Отдельно от БД и сети — ради тестов и ради
// того, чтобы порядок веток был виден целиком в одном месте.
//   confirm  — подтверждение пришло, строка закрыта;
//   wait     — порог ещё не вышел;
//   retry    — не подтвердилось, это первая попытка и она не протухла;
//   escalate — не подтвердилось у повтора ЛИБО первая попытка уже протухла.
function decide(row, { confirmed, thresholdMin, nowMs, maxRetryAgeMin = MAX_RETRY_AGE_MIN }) {
  if (confirmed) return 'confirm';
  const ageMin = (nowMs - new Date(row.created_at).getTime()) / 60000;
  if (!(ageMin >= thresholdMin)) return 'wait';
  // NaN-возраст (битая дата) сюда не дойдёт: сравнение выше вернёт 'wait'.
  if (row.retry_of == null && ageMin <= maxRetryAgeMin) return 'retry';
  return 'escalate';
}

// ── Работа с БД ─────────────────────────────────────────────
function store() {
  const { db } = require('../../db');
  return {
    async insert(row) {
      const r = await db.query(
        `INSERT INTO agent_reply_deliveries
           (salon_id, dialog_key, channel, phone, chat_id, reply_to_message_id,
            delivery_id, text, retry_of)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [row.salonId, row.dialogKey, row.channel, row.phone, row.chatId,
         row.replyToMessageId, String(row.deliveryId), row.text, row.retryOf || null]);
      return r.rows[0].id;
    },
    async listPending() {
      return db.any(
        `SELECT * FROM agent_reply_deliveries WHERE status = 'pending'
          ORDER BY id LIMIT ${BATCH}`);
    },
    // Есть ли у строки УЖЕ отправленный повтор. Нужна потому, что пометка
    // исходной строки стоит ПОСЛЕ отправки (иначе краш между пометкой и
    // отправкой оставил бы клиента без ответа молча, без единого сигнала), и
    // сбой БД ровно в этом окне вернул бы строку в следующий тик как «первую
    // попытку» — то есть дал бы ВТОРОЙ повтор вопреки договорённости.
    async hasRetry(id) {
      const r = await db.oneOrNone(
        'SELECT 1 FROM agent_reply_deliveries WHERE retry_of = $1 LIMIT 1', [id]);
      return !!r;
    },
    // Подтверждение — ЛЮБОЕ событие Chatpush с этим delivery_id: статус доставки
    // (message_status) или эхо (*_incoming_msg с direction=outgoing). Без фильтра
    // по salon_id: у message_status он всегда NULL, а delivery_id уникален глобально.
    async isConfirmed(deliveryId) {
      const r = await db.oneOrNone(
        `SELECT 1 FROM chatpush_events
          WHERE payload->'payload'->>'delivery_id' = $1 LIMIT 1`, [String(deliveryId)]);
      return !!r;
    },
    async setStatus(id, status) {
      await db.query(
        `UPDATE agent_reply_deliveries SET status = $2, resolved_at = NOW()
          WHERE id = $1 AND status = 'pending'`, [id, status]);
    },
    // Повторная отправка получает НОВЫЙ delivery_id, а строка в «Чате» уже
    // сохранена под старым (external_message_id = api:<id>). Перецепляем её на
    // новый id, иначе эхо повтора не сдедупится и один и тот же ответ ляжет в
    // переписку дважды. Только whatsapp: остальные каналы при отправке не персистим.
    async repointChatRow(salonId, oldDeliveryId, newDeliveryId) {
      await db.query(
        `UPDATE chatpush_messages SET external_message_id = $3
          WHERE salon_id = $1 AND external_message_id = $2`,
        [salonId, chatpush.ownOutgoingExternalId(oldDeliveryId),
         chatpush.ownOutgoingExternalId(newDeliveryId)]);
    },
  };
}

// ── Запись отправки (зовёт диспетчер) ───────────────────────
// Best-effort: журнал не имеет права стоить клиенту ответа. Возвращает id строки
// или null (нечего писать / сбой БД).
async function record(salonId, dialogKey, meta, text, delivery, deps = {}) {
  if (!delivery || delivery.id == null) return null;
  const st = deps.store || store();
  try {
    return await st.insert({
      salonId,
      dialogKey,
      channel: meta.channel || null,
      phone: meta.phone || null,
      chatId: meta.chatId || null,
      replyToMessageId: meta.messageId || null,
      deliveryId: delivery.id,
      text: String(text || ''),
    });
  } catch (e) {
    logger.warn(`журнал отправки не записан (dialog ${dialogKey}, delivery ${delivery.id}): ${e.message}`);
    return null;
  }
}

// ── Проход ──────────────────────────────────────────────────
async function sweep(deps = {}) {
  const config = deps.config || configDefault;
  if (!config.AGENT_DELIVERY_WATCHDOG) return { checked: 0, skipped: 'disabled' };
  const st = deps.store || store();
  const send = deps.send || defaultResend;
  const escalate = deps.escalate || defaultEscalate;
  const nowMs = deps.nowMs || Date.now();
  const thresholdMin = Number(config.AGENT_DELIVERY_WATCHDOG_MIN) || 5;

  const rows = await st.listPending();
  const out = { checked: rows.length, confirmed: 0, retried: 0, escalated: 0 };
  for (const row of rows) {
    try {
      const confirmed = await st.isConfirmed(row.delivery_id);
      const action = decide(row, { confirmed, thresholdMin, nowMs });
      if (action === 'wait') continue;
      if (action === 'confirm') { await st.setStatus(row.id, 'confirmed'); out.confirmed++; continue; }
      if (action === 'retry') {
        // Повтор прошлого тика ушёл, а пометка исходной строки не легла (сбой БД):
        // отправлять ВТОРОЙ раз нельзя — просто закрываем строку, судьбу повтора
        // сторож дальше ведёт по его собственной строке.
        if (await st.hasRetry(row.id)) { await st.setStatus(row.id, 'retried'); continue; }
        logger.error(`реплика не подтверждена за ${thresholdMin} мин (dialog ${row.dialog_key}, ${row.channel}, delivery ${row.delivery_id}) — повторяю отправку: «${String(row.text).replace(/\s+/g, ' ').slice(0, 500)}»`);
        const delivery = await send(row);
        if (!delivery || delivery.id == null) throw new Error('повтор не принят Chatpush');
        // Порядок важен: сначала НОВАЯ строка журнала (иначе повтор, не попавший
        // в журнал, никто уже не проверит), потом закрываем старую.
        await st.insert({
          salonId: row.salon_id,
          dialogKey: row.dialog_key,
          channel: row.channel,
          phone: row.phone,
          chatId: row.chat_id,
          replyToMessageId: row.reply_to_message_id,
          deliveryId: delivery.id,
          text: row.text,
          retryOf: row.id,
        });
        await st.setStatus(row.id, 'retried');
        if (row.channel === 'whatsapp') {
          try { await st.repointChatRow(row.salon_id, row.delivery_id, delivery.id); }
          catch (e) { logger.warn(`строка «Чата» не перецеплена на повтор (delivery ${row.delivery_id}): ${e.message}`); }
        }
        out.retried++;
        continue;
      }
      // escalate
      logger.error(`реплика не доставлена и после повтора (dialog ${row.dialog_key}, ${row.channel}, delivery ${row.delivery_id}) — перевожу на администратора: «${String(row.text).replace(/\s+/g, ' ').slice(0, 500)}»`);
      await escalate(row.salon_id, row.dialog_key,
        `сообщение бота не доставлено мессенджером (delivery ${row.delivery_id}) — клиент без ответа`);
      await st.setStatus(row.id, 'failed');
      out.escalated++;
    } catch (e) {
      // Строку не закрываем: останется pending и будет разобрана следующим тиком.
      logger.error(`строка журнала ${row.id} (delivery ${row.delivery_id}) не обработана: ${e.message}`);
    }
  }
  return out;
}

async function defaultResend(row) {
  const token = configDefault.CHATPUSH.instanceToken;
  if (!token) throw new Error('CHATPUSH_INSTANCE_TOKEN не задан');
  return chatpush.sendMessage(token, {
    text: row.text,
    phone: row.phone,
    dispatchRouting: [chatpush.replyRoutingFor(row.channel)],
    replyToMessageId: row.reply_to_message_id,
  });
}

// Тот же перевод на человека, что делает инструмент агента: одна запись —
// одно правило (подсветка в «Чате», SSE, каскад по «Заботе»).
async function defaultEscalate(salonId, dialogKey, reason) {
  return escalateTool.run(salonId, { reason }, { dialogKey });
}

// Журнал — форензика: держим 30 дней, как agent_tool_events.
async function cleanup(days = 30) {
  const { db } = require('../../db');
  try {
    await db.query(
      `DELETE FROM agent_reply_deliveries WHERE created_at < NOW() - ($1 || ' days')::interval`,
      [String(days)]);
  } catch (e) {
    logger.warn(`чистка журнала отправок не выполнена: ${e.message}`);
  }
}

module.exports = { record, sweep, decide, cleanup, MAX_RETRY_AGE_MIN, BATCH };
