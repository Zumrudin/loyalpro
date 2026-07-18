// ============================================================
// Chatpush Webhook — приём входящих сообщений
// ------------------------------------------------------------
// Chatpush шлёт сюда события (whatsapp_incoming_msg, tdlib_incoming_msg,
// whatsapp_status_msg, log_in/out, …). Регистрируем URL как:
//   https://<host>/chatpush/webhook?key=<CHATPUSH_WEBHOOK_SECRET>
// (см. services/chatpush.createWebhook). Секрет едет в `?key=` — Chatpush не
// подписывает тело, поэтому сверяем ключ из URL, как в YClients-вебхуке.
//
// Фаза 1: принимаем и СОХРАНЯЕМ всё (chatpush_events + chatpush_messages).
// Авто-ответ — только если CHATPUSH_AGENT_ENABLED=true (по умолчанию выкл).
//
// Монтируется ДО JWT-guard (routes/index.js), рядом с /yclients.
// ============================================================
const router = require('express').Router();
const crypto = require('crypto');
const config = require('../config');
const { db } = require('../db');
const chatpush = require('../services/chatpush');
const { phoneMatchCandidates } = require('../services/chat');
const { generateReply } = require('../services/chatpush-agent');
const agentSettings = require('../services/agent-settings');
const { createLogger } = require('../logger');
const logger = createLogger('ChatpushWebhook');

/**
 * Сверить общий секрет из `?key=` (timing-safe). Пустой секрет → legacy-режим
 * (принимаем без проверки), чтобы доставка не ломалась до настройки.
 */
function verifySecret(req) {
  const secret = config.CHATPUSH.webhookSecret;
  if (!secret) return { ok: true, mode: 'legacy' };

  const provided = typeof req.query.key === 'string' ? req.query.key : '';
  if (!provided) return { ok: false, reason: 'missing key' };

  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return { ok: false, reason: 'key mismatch' };
  return crypto.timingSafeEqual(a, b)
    ? { ok: true, mode: 'verified' }
    : { ok: false, reason: 'key mismatch' };
}

/**
 * Инстанс (customer_id) → salon_id. Фаза 1 — single-tenant из env
 * (CHATPUSH_CUSTOMER_ID / CHATPUSH_SALON_ID). Если не настроено — null
 * (событие всё равно сохраняем, но без привязки к салону).
 * TODO: заменить колонкой salons.chatpush_customer_id для мультисалона.
 */
function resolveSalonId(customerId) {
  const { customerId: cfgCustomer, salonId } = config.CHATPUSH;
  if (salonId && (!cfgCustomer || cfgCustomer === customerId)) return salonId;
  return null;
}

/**
 * Найти клиента салона по номеру телефона входящего/исходящего сообщения.
 * Возвращает clients.id или null (номера нет / клиент не найден / нет салона).
 * Точное сравнение по вариантам формата (phoneMatchCandidates) → индекс.
 */
async function matchClientId(salonId, phone) {
  if (!salonId || !phone) return null;
  const candidates = phoneMatchCandidates(phone);
  if (!candidates.length) return null;
  try {
    const row = await db.oneOrNone(
      'SELECT id FROM clients WHERE salon_id=$1 AND phone = ANY($2) LIMIT 1',
      [salonId, candidates]
    );
    return row?.id || null;
  } catch (e) {
    logger.warn(`client match failed for ${phone}: ${e.message}`);
    return null;
  }
}

router.post('/webhook', async (req, res) => {
  const t0 = Date.now();

  const sig = verifySecret(req);
  if (!sig.ok) {
    logger.warn(`webhook key check failed: ${sig.reason}`);
    return res.status(401).json({ error: 'invalid key' });
  }
  if (sig.mode === 'legacy') {
    logger.warn('legacy unauthenticated webhook accepted — set CHATPUSH_WEBHOOK_SECRET and register the URL with ?key=<secret> to enable enforcement');
  }

  // ACK немедленно — Chatpush (как и YClients) ретраит при таймауте.
  res.json({ ok: true });

  const body = req.body || {};
  const msg = chatpush.parseMessageEvent(body);          // сообщение (in/out) или null
  const customerId = body.payload?.instance?.customer_id ?? msg?.customerId ?? null;
  const salonId = resolveSalonId(customerId);

  // 1) СЫРОЙ лог любого события — до обработки.
  let eventId = null;
  try {
    const row = await db.one(
      `INSERT INTO chatpush_events (salon_id, customer_id, type, direction, external_message_id, phone, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [salonId, customerId, body.type || null, msg?.direction || null,
       msg?.messageId || null, msg?.phone || null, JSON.stringify(body)]
    );
    eventId = row?.id || null;
  } catch (e) {
    logger.error(`event log failed: ${e.message}`);
  }

  try {
    // 2) Нормализованное сообщение (входящее И исходящее-эхо) — вся переписка.
    if (msg && msg.messageId) {
      // Сматчить клиента по номеру телефона, чтобы в чате показывать имя из
      // клиентской базы. Точное сравнение по вариантам формата → индекс
      // idx_clients_phone. Номер клиента одинаков для in/out, поэтому весь
      // диалог привязывается к клиенту независимо от направления.
      const clientId = await matchClientId(salonId, msg.phone);
      await db.query(
        `INSERT INTO chatpush_messages
           (salon_id, client_id, customer_id, channel, direction, external_message_id, reply_to_message_id,
            msg_type, text, file_url, mime_type, sender_name, phone, chat_id, msg_ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (salon_id, external_message_id) DO NOTHING`,
        [salonId, clientId, customerId, msg.channel, msg.direction, msg.messageId, msg.replyToMessageId,
         msg.type, msg.text, msg.fileUrl, msg.mimeType, msg.senderName, msg.phone, msg.chatId, msg.timestamp]
      );
      logger.info(`stored ${msg.direction} ${msg.channel} ${msg.phone || ''}${clientId ? ` (client #${clientId})` : ''}: ${(msg.text || '').slice(0, 60)}`);
    } else {
      logger.debug(`non-message event type=${body.type} stored (event only)`);
    }

    if (eventId) {
      await db.query('UPDATE chatpush_events SET processed=TRUE WHERE id=$1', [eventId]);
    }

    // 3) Авто-ответ — при глобальном флаге (env kill-switch) И допуске из админки
    //    (per-salon вкл/выкл + белый/чёрный список), только на входящее.
    if (config.CHATPUSH.agentEnabled && msg && msg.direction === 'incoming') {
      const gate = await agentSettings.isAllowed(salonId, msg.phone);
      if (!gate.allow) {
        logger.info(`agent gate: skip ${msg.phone || msg.chatId || '?'} (${gate.reason})`);
      } else {
        const reply = await generateReply(msg);
        if (!reply) return;
        const token = config.CHATPUSH.instanceToken;
        if (!token) { logger.error('CHATPUSH_INSTANCE_TOKEN not set — cannot reply'); return; }
        const delivery = await chatpush.sendMessage(token, {
          text: reply,
          phone: msg.phone,
          dispatchRouting: [chatpush.replyRoutingFor(msg.channel)],
          replyToMessageId: msg.messageId,
        });
        logger.info(`agent replied to ${msg.phone} (delivery=${delivery?.id}) in ${Date.now() - t0}ms`);
      }
    }
  } catch (e) {
    logger.error(`ERROR: ${e.message}`);
    if (eventId) {
      try { await db.query('UPDATE chatpush_events SET error=$1 WHERE id=$2', [e.message, eventId]); } catch {}
    }
  }
});

module.exports = router;
