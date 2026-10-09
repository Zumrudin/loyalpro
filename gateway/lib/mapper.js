'use strict';
// ============================================================
// Mapper — чистые функции без TDLib/БД/HTTP: сообщение TDLib → тело вебхука
// в плоской tdlib-форме Chatpush (её разбирает backend/services/chatpush.js
// envelope()), составные id, телефоны, статусы доставки.
// ============================================================

function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  // TDLib отдаёт полные международные номера: 7 дописываем только российскому
  // мобильному без кода страны (10 цифр, начинается с 9).
  if (d.length === 10 && d[0] === '9') d = '7' + d;
  return d.length >= 10 && d.length <= 15 ? d : null;
}

// Message id TDLib уникален только внутри чата → наружу уходит "<chat>:<msg>".
// Id другого формата (например, числовой id Chatpush-эпохи в reply_to после
// переключения канала) — не наш, parseCompositeId отдаёт null, вызывающий
// просто не ставит reply.
function compositeId(chatId, messageId) { return `${chatId}:${messageId}`; }
function parseCompositeId(s) {
  const mm = /^(-?\d+):(\d+)$/.exec(String(s || ''));
  return mm ? { chatId: Number(mm[1]), messageId: Number(mm[2]) } : null;
}

function largestPhoto(photo) {
  const sizes = (photo && photo.sizes) || [];
  let best = null;
  for (const s of sizes) if (!best || (s.width || 0) > (best.width || 0)) best = s;
  return best ? best.photo : null;
}

// Содержимое → {type, text, file:{id, mimeType, fileName}|null}. type — как у
// Chatpush: текст 'formattedText', медиа 'image'|'document'|'voice'|'video'
// (бэкенд: isMedia = type не содержит 'text'; mediaLabel по подстрокам).
function contentOf(content) {
  const c = content || {};
  switch (c._) {
    case 'messageText':
      return { type: 'formattedText', text: (c.text && c.text.text) || '', file: null };
    case 'messagePhoto': {
      const f = largestPhoto(c.photo);
      return { type: 'image', text: (c.caption && c.caption.text) || '', file: f ? { id: f.id, mimeType: 'image/jpeg', fileName: null } : null };
    }
    case 'messageDocument': {
      const d = c.document || {};
      return { type: 'document', text: (c.caption && c.caption.text) || '',
        file: d.document ? { id: d.document.id, mimeType: d.mime_type || 'application/octet-stream', fileName: d.file_name || null } : null };
    }
    case 'messageVoiceNote': {
      const v = c.voice_note || {};
      return { type: 'voice', text: (c.caption && c.caption.text) || '', file: v.voice ? { id: v.voice.id, mimeType: v.mime_type || 'audio/ogg', fileName: null } : null };
    }
    case 'messageVideo': {
      const v = c.video || {};
      return { type: 'video', text: (c.caption && c.caption.text) || '',
        file: v.video ? { id: v.video.id, mimeType: v.mime_type || 'video/mp4', fileName: v.file_name || null } : null };
    }
    case 'messageVideoNote': {
      const v = c.video_note || {};
      return { type: 'video', text: '', file: v.video ? { id: v.video.id, mimeType: 'video/mp4', fileName: null } : null };
    }
    case 'messageAudio': {
      const a = c.audio || {};
      return { type: 'audio', text: (c.caption && c.caption.text) || '',
        file: a.audio ? { id: a.audio.id, mimeType: a.mime_type || 'audio/mpeg', fileName: a.file_name || null } : null };
    }
    case 'messageAnimation': {
      const a = c.animation || {};
      return { type: 'video', text: (c.caption && c.caption.text) || '',
        file: a.animation ? { id: a.animation.id, mimeType: a.mime_type || 'video/mp4', fileName: a.file_name || null } : null };
    }
    default: {
      // Прочее (стикер, контакт, геопозиция…): тип = имя TDLib без префикса
      // 'message', в нижнем регистре. Бэкенд считает медиа всё без 'text' в типе.
      const mm = /^message(.+)$/.exec(c._ || '');
      return { type: mm ? mm[1].toLowerCase() : 'unsupported', text: '', file: null };
    }
  }
}

function isGroupChat(chat) {
  const t = chat && chat.type && chat.type._;
  return t === 'chatTypeBasicGroup' || t === 'chatTypeSupergroup';
}

function fullName(user) {
  return [user && user.first_name, user && user.last_name].filter(Boolean).join(' ').trim() || null;
}

/**
 * Тело вебхука. peer — собеседник (в личке — второй участник, в группе —
 * отправитель сообщения). Номера строго по стороне клиента, как ждёт
 * envelope(): у incoming клиент в sender_phone_number, у outgoing — в
 * recipient_phone_number; наш номер стоит на второй стороне.
 */
function buildWebhookBody({ accountId, ownPhone, message, chat, peer, deliveryId, fileUrl }) {
  const msg = message || {};
  const content = contentOf(msg.content);
  const outgoing = !!msg.is_outgoing;
  // У исходящего в группе нет единственного получателя: наш номер на клиентскую
  // сторону класть нельзя.
  const groupOut = outgoing && isGroupChat(chat);
  const peerPhone = normalizePhone(peer && peer.phone_number);
  const peerName = fullName(peer);
  // message_id 0 — ответ на сообщение из неизвестного чата: ссылаться не на что.
  const replyTo = msg.reply_to && msg.reply_to._ === 'messageReplyToMessage' && msg.reply_to.message_id
    ? compositeId(msg.reply_to.chat_id != null ? msg.reply_to.chat_id : msg.chat_id, msg.reply_to.message_id) : null;
  const m = {
    id: compositeId(msg.chat_id, msg.id),
    type: content.type,
    text: content.text,
    timestamp: msg.date || null,
    reply_to_message_id: replyTo,
  };
  if (content.file && fileUrl) {
    m.file_data = { download_url: fileUrl, mime_type: content.file.mimeType, caption: content.text };
  }
  return {
    type: 'tdlib_incoming_msg',
    payload: {
      provider: 'gateway',
      customer_id: accountId,
      instance_id: accountId,
      direction: outgoing ? 'outgoing' : 'incoming',
      chat_id: String(msg.chat_id),
      chat_type: isGroupChat(chat) ? 'group' : 'person',
      sender_phone_number: outgoing ? (ownPhone || null) : peerPhone,
      recipient_phone_number: groupOut ? null : (outgoing ? peerPhone : (ownPhone || null)),
      sender_name: outgoing ? null : peerName,
      recipient_username: outgoing && !groupOut ? peerName : null,
      delivery_id: deliveryId || null,
      timestamp: msg.date || null,
      message: m,
    },
  };
}

// Строка gateway_deliveries → объект delivery в форме Chatpush.
function deliveryStatus(row) {
  return { id: `g${row.id}`, status: { status_id: Number(row.status_id), description: row.description }, error: row.error || null };
}

module.exports = { normalizePhone, compositeId, parseCompositeId, contentOf, buildWebhookBody, deliveryStatus, isGroupChat, fullName };
