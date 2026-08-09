'use strict';
// Персист исходящих касаний в chatpush_messages вне обычного эхо-пути.
// Вынесено из routes/chat.js (Task 10, «Отдел заботы») без изменения логики —
// используется и ручной отправкой оператора (routes/chat.js), и care-воркером
// (services/care/worker.js).
const { db } = require('../db');
const config = require('../config');
const { phoneMatchCandidates, dialogKey } = require('./chat');
const chatpush = require('./chatpush');
const chatEvents = require('./chat-events');
const { createLogger } = require('../logger');
const logger = createLogger('Chat');

// Сохранить исходящее в WhatsApp СРАЗУ при отправке + запушить в SSE.
// Chatpush перестал слать эхо наших WhatsApp-отправок (см. services/chatpush) —
// без этого сообщение живёт лишь оптимистичным пузырём и пропадает после
// перезагрузки. tdlib/max эхо шлют исправно, их сохраняет вебхук — не трогаем.
// external_message_id = api:<delivery_id>: если эхо вернётся, вебхук дедупит по
// нему (chatpush.deliveryIdFromWhatsappEchoId). ON CONFLICT — на случай гонки.
// authoredBy — кто автор строки (`agent` | `operator` | `system` | null). До
// 09.08.2026 персист его не выставлял вовсе, потому что им пользовались только
// пути, чьё эхо всё равно приходило и проставляло автора само. Реплики Милы в
// WhatsApp такого эха могут не дождаться (инцидент 2026-08-09): вебхук на нашей
// же строке уходит в ветку дедупа и до classify не доходит, поэтому автора
// обязан проставить сам отправитель — иначе в «Чате» ответ бота неотличим от
// строки со сбоем классификации.
async function persistWhatsappOutgoing(salonId, { delivery, phone, chatId, text, msgType, fileUrl, mimeType, authoredBy = null }) {
  if (!salonId || !delivery || delivery.id == null) return;
  let clientId = null;
  try {
    const cands = phoneMatchCandidates(phone);
    if (cands.length) {
      const row = await db.oneOrNone(
        'SELECT id FROM clients WHERE salon_id=$1 AND phone = ANY($2) LIMIT 1', [salonId, cands]);
      clientId = row?.id || null;
    }
  } catch (e) { logger.warn(`client match failed for ${phone}: ${e.message}`); }

  const ts = Math.floor(Date.now() / 1000);
  const externalId = chatpush.ownOutgoingExternalId(delivery.id);
  const ins = await db.query(
    `INSERT INTO chatpush_messages
       (salon_id, client_id, customer_id, channel, direction, external_message_id,
        msg_type, text, file_url, mime_type, phone, chat_id, msg_ts, authored_by)
     VALUES ($1,$2,$3,'whatsapp','outgoing',$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (salon_id, external_message_id) DO NOTHING
     RETURNING id`,
    [salonId, clientId, config.CHATPUSH.customerId, externalId,
     msgType, text || '', fileUrl, mimeType, phone, chatId, ts, authoredBy]
  );
  if (ins.rowCount > 0) {
    chatEvents.emit(salonId, {
      type: 'message',
      dialogKey: dialogKey({ phone, chat_id: chatId }),
      message: {
        id: ins.rows[0].id, direction: 'outgoing', channel: 'whatsapp',
        msg_type: msgType, text: text || '',
        file_url: fileUrl, mime_type: mimeType, sender_name: null, msg_ts: ts,
      },
    });
  }
}

module.exports = { persistWhatsappOutgoing };
