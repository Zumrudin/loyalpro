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
const { phoneMatchCandidates, dialogKey: chatDialogKey } = require('../services/chat');
const chatEvents = require('../services/chat-events');
const dispatcher = require('../services/agent/dispatcher');

// Текстовые типы разных каналов: WhatsApp/MAX → 'text', tdlib/Telegram → 'formattedText'.
const AGENT_TEXT_TYPES = new Set(['text', 'formattedText']);
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
    // Вставилось ли НОВОЕ сообщение (а не дубль ретрая) — гейтит авто-ответ ниже.
    let storedNew = false;
    // 2) Нормализованное сообщение (входящее И исходящее-эхо) — вся переписка.
    if (msg && msg.messageId) {
      // Сматчить клиента по номеру телефона, чтобы в чате показывать имя из
      // клиентской базы. Точное сравнение по вариантам формата → индекс
      // idx_clients_phone. Номер клиента одинаков для in/out, поэтому весь
      // диалог привязывается к клиенту независимо от направления.
      const clientId = await matchClientId(salonId, msg.phone);
      const ins = await db.query(
        `INSERT INTO chatpush_messages
           (salon_id, client_id, customer_id, channel, direction, external_message_id, reply_to_message_id,
            msg_type, text, file_url, mime_type, sender_name, phone, chat_id, msg_ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (salon_id, external_message_id) DO NOTHING
         RETURNING id`,
        [salonId, clientId, customerId, msg.channel, msg.direction, msg.messageId, msg.replyToMessageId,
         msg.type, msg.text, msg.fileUrl, msg.mimeType, msg.senderName, msg.phone, msg.chatId, msg.timestamp]
      );
      storedNew = ins.rowCount > 0;
      logger.info(`stored ${msg.direction} ${msg.channel} ${msg.phone || ''}${clientId ? ` (client #${clientId})` : ''}: ${(msg.text || '').slice(0, 60)}`);

      // Живое обновление страницы «Чат»: пушим сохранённое сообщение (вкл.
      // исходящее-эхо — так на странице появляются ответы бота и оператора).
      // Форма message — как у строк GET /dialogs/:key/messages.
      if (storedNew && salonId) {
        chatEvents.emit(salonId, {
          type: 'message',
          dialogKey: chatDialogKey({ phone: msg.phone, chat_id: msg.chatId }),
          message: {
            id: ins.rows[0].id,
            direction: msg.direction, channel: msg.channel,
            msg_type: msg.type, text: msg.text,
            file_url: msg.fileUrl, mime_type: msg.mimeType,
            sender_name: msg.senderName, msg_ts: msg.timestamp,
          },
        });
      }
    } else {
      logger.debug(`non-message event type=${body.type} stored (event only)`);
    }

    if (eventId) {
      await db.query('UPDATE chatpush_events SET processed=TRUE WHERE id=$1', [eventId]);
    }

    // 3) Авто-ответ агента — при глобальном флаге (env kill-switch) И только на
    //    ВХОДЯЩЕЕ текстовое сообщение. Гейт допуска (per-salon вкл/выкл + бело/чёрный
    //    список), дебаунс серии, ReAct-цикл и отправка — внутри диспетчера.
    if (
      config.CHATPUSH.agentEnabled &&
      storedNew &&
      msg && msg.direction === 'incoming' &&
      AGENT_TEXT_TYPES.has(msg.type) && (msg.text || '').trim()
    ) {
      const dialogKey = (msg.phone && msg.phone.trim()) || msg.chatId;
      if (dialogKey) {
        dispatcher.enqueue(salonId, dialogKey, {
          phone: msg.phone,
          channel: msg.channel,
          messageId: msg.messageId,
        });
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
