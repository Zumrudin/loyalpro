'use strict';
// ============================================================
// WA-mapper — чистые функции без Baileys/БД/HTTP: сообщение Baileys → тело
// вебхука во ВЛОЖЕННОЙ WhatsApp-форме Chatpush (её разбирает
// backend/services/chatpush.js envelope(), ветка payload.new_message), jid ↔
// телефон, составные id, типы контента, статусы доставки.
// Телефон собеседника — цепочкой: remoteJid вида @s.whatsapp.net → key.senderPn
// (личка в LID-чате) / key.participantPn (группа) → кэш LID→телефон
// (gateway_contacts) → null (диалог живёт по chat_id '<lid>@lid').
// ============================================================
const { normalizePhone } = require('./mapper');

const PN_RE = /^(\d+)(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/;
const LID_RE = /^(\d+)(?::\d+)?@lid$/;

function phoneOfJid(jid) {
  const mm = PN_RE.exec(String(jid || ''));
  return mm ? normalizePhone(mm[1]) : null;
}
function lidOfJid(jid) {
  const mm = LID_RE.exec(String(jid || ''));
  return mm ? mm[1] : null;
}
function isGroupJid(jid) { return /@g\.us$/.test(String(jid || '')); }
function isSkippedJid(jid) { return /@(broadcast|newsletter)$/.test(String(jid || '')); }

// lookup(lid) → телефон из кэша или null (синхронно: вызывающий заранее читает БД).
function peerPhone(key, lookup) {
  const k = key || {};
  if (isGroupJid(k.remoteJid)) {
    return phoneOfJid(k.participantPn) || phoneOfJid(k.participant) || lookup(lidOfJid(k.participant)) || null;
  }
  return phoneOfJid(k.remoteJid) || phoneOfJid(k.senderPn) || lookup(lidOfJid(k.remoteJid)) || null;
}

// chat_id как у Chatpush: личный с известным номером — '<phone>@c.us'
// (backend/services/agent/group-chat.js считает такой личным), группа — jid как
// есть, личный без номера — '<lid>@lid'.
function chatIdOf(remoteJid, phone) {
  if (isGroupJid(remoteJid)) return String(remoteJid);
  if (phone) return `${phone}@c.us`;
  return String(remoteJid || '');
}

// key.id у WhatsApp уникален только вместе с чатом → наружу составной id в духе
// Chatpush ('true_<lid>_<id>'). Пробелов и '_' в jid/id нет: '_' — разделитель.
function compositeId(key) { return `${key.fromMe ? 'true' : 'false'}_${key.remoteJid}_${key.id}`; }
function parseCompositeId(s) {
  const mm = /^(true|false)_([^_\s]+)_([A-Za-z0-9-]+)$/.exec(String(s || ''));
  return mm ? { fromMe: mm[1] === 'true', remoteJid: mm[2], id: mm[3] } : null;
}

const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage'];
const SKIP = new Set(['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'pollUpdateMessage', 'keepInChatMessage']);

function unwrap(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    const w = WRAPPERS.find(k => m[k] && m[k].message);
    if (!w) break;
    m = m[w].message;
  }
  return m;
}

// → {type, text, media:{contentType, mimeType, fileName, size}|null} | null (служебное/пусто).
function contentOf(message) {
  const m = unwrap(message);
  if (!m || typeof m !== 'object') return null;
  // Декодированный proto (protobufjs) держит ВСЕ поля на прототипе со
  // значением null: `m.conversation !== undefined` истинно у ЛЮБОГО сообщения,
  // и фото/служебное читались бы пустым текстом. Поэтому — только непустые строки
  // и только собственные ключи (Object.keys не видит прототип).
  const strOf = (v) => (typeof v === 'string' ? v : '');
  const keys = Object.keys(m).filter(k => !SKIP.has(k) && m[k] !== null && m[k] !== undefined);
  const conv = strOf(m.conversation);
  if (conv.trim()) return { type: 'text', text: conv, media: null };
  const ext = m.extendedTextMessage && strOf(m.extendedTextMessage.text);
  if (ext && ext.trim()) return { type: 'text', text: ext, media: null };
  // Пустой текст без медиа в чат ничего не несёт — служебное.
  const ct = keys.find(k => /Message$/.test(k) && k !== 'extendedTextMessage' && typeof m[k] === 'object');
  if (!ct) return null;
  const c = m[ct];
  const size = tsOf(c.fileLength) || 0;   // uint64 → Long у декодированного proto
  const mediaOf = (mime, fileName) => ({ contentType: ct, mimeType: String(mime || '').split(';')[0].trim() || 'application/octet-stream', fileName: fileName || null, size });
  switch (ct) {
    case 'imageMessage':    return { type: 'image', text: String(c.caption || ''), media: mediaOf(c.mimetype || 'image/jpeg') };
    case 'documentMessage': return { type: 'document', text: String(c.caption || ''), media: mediaOf(c.mimetype, c.fileName) };
    case 'audioMessage':    return { type: c.ptt ? 'voice' : 'audio', text: '', media: mediaOf(c.mimetype || 'audio/ogg') };
    case 'videoMessage':    return { type: 'video', text: String(c.caption || ''), media: mediaOf(c.mimetype || 'video/mp4') };
    case 'stickerMessage':  return { type: 'sticker', text: '', media: null };
    default:                return { type: ct.replace(/Message$/, '').toLowerCase(), text: '', media: null };
  }
}

function tsOf(ts) {
  if (ts === undefined || ts === null) return null;
  if (typeof ts === 'object' && typeof ts.toNumber === 'function') return ts.toNumber();
  const n = Number(ts);
  return Number.isFinite(n) ? n : null;
}

/**
 * Тело вебхука во вложенной форме. Номера строго по стороне клиента, как ждёт
 * envelope(): у incoming клиент в sender_phone_number, у outgoing — в
 * recipient_phone_number; наш номер — на второй стороне. У исходящего в
 * группе единственного получателя нет → recipient null.
 */
function buildWebhookBody({ accountId, ownPhone, msg, peerPhone: phone, deliveryId, fileUrl }) {
  const key = msg.key || {};
  const outgoing = !!key.fromMe;
  const group = isGroupJid(key.remoteJid);
  const content = contentOf(msg.message) || { type: 'unsupported', text: '', media: null };
  const message = {
    id: compositeId(key),
    type: content.type,
    text: content.text,
    timestamp: tsOf(msg.messageTimestamp),
    reply_to_message_id: null,
  };
  if (content.media && fileUrl) message.file_data = { download_url: fileUrl, mime_type: content.media.mimeType, caption: content.text };
  return {
    type: 'whatsapp_incoming_msg',
    payload: {
      provider: 'gateway',
      customer_id: accountId,
      instance_id: accountId,
      delivery_id: deliveryId || null,
      new_message: {
        direction: outgoing ? 'outgoing' : 'incoming',
        chat_id: chatIdOf(key.remoteJid, group ? null : phone),
        chat_type: group ? 'group' : 'person',
        chat_phone: group ? null : (phone || null),
        sender_phone_number: outgoing ? (ownPhone || null) : (phone || null),
        recipient_phone_number: outgoing ? (group ? null : (phone || null)) : (ownPhone || null),
        pushname: outgoing ? null : (msg.pushName || null),
        sender_name: outgoing ? null : (msg.pushName || null),
        message,
      },
    },
  };
}

function deliveryStatus(row) {
  return { id: `g${row.id}`, status: { status_id: Number(row.status_id), description: row.description }, error: row.error || null };
}

module.exports = { phoneOfJid, lidOfJid, isGroupJid, isSkippedJid, peerPhone, chatIdOf, compositeId, parseCompositeId, contentOf, tsOf, buildWebhookBody, deliveryStatus };
