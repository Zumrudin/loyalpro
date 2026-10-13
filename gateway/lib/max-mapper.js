'use strict';
// ============================================================
// max-mapper — чистые функции без сети/БД: сообщение веб-протокола MAX → тело
// вебхука в ПЛОСКОЙ форме max_incoming_msg Chatpush (её разбирает
// backend/services/chatpush.js envelope(): телефон клиента у incoming —
// sender_phone_number, у outgoing — recipient_phone_number; группа — chat_type
// 'group' и отрицательный chat_id). chat_id личного диалога = id СОБЕСЕДНИКА — так
// делал Chatpush, и диалоги без номера в нашей БД ключуются именно им.
// id личного диалога в MAX = XOR id двух участников (PyMax UserService.get_chat_id);
// XOR через BigInt — побитовые операции Number режут id до 32 бит.
// Типы сообщений как у Chatpush для MAX: text | image | document | audio | video |
// sticker | contact (бэкенд: isMedia = тип без 'text').
// ============================================================
const path = require('path');
const { normalizePhone } = require('./mapper');
const { EXT_BY_MIME } = require('./media');

const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime]));
MIME_BY_EXT['.jpeg'] = 'image/jpeg';

function xorId(a, b) { return Number(BigInt(a) ^ BigInt(b)); }

// Собеседник личного диалога: второй участник снимка чата, иначе XOR.
function peerIdOf({ chatId, chat, ownerId }) {
  const me = Number(ownerId);
  const parts = chat && chat.participants && typeof chat.participants === 'object'
    ? Object.keys(chat.participants).map(Number).filter(n => Number.isFinite(n) && n !== me)
    : [];
  if (parts.length === 1) return parts[0];
  return xorId(chatId, me);
}

function isGroupChat({ chatId, chat }) {
  if (chat && chat.type) return chat.type !== 'DIALOG';
  return Number(chatId) < 0;
}
function isChannel(chat) { return !!(chat && chat.type === 'CHANNEL'); }

function mimeOfName(name) { return MIME_BY_EXT[path.extname(String(name || '')).toLowerCase()] || 'application/octet-stream'; }

// → {type, text, media:{kind, url, fileId, fileName, mimeType, size}|null} | null (не форвардим).
function contentOf(message) {
  const m = message && typeof message === 'object' ? message : null;
  if (!m) return null;
  if (m.type && m.type !== 'USER') return null;      // SYSTEM/CONTROL — служебное
  if (m.status) return null;                         // EDITED/REMOVED — ре-броадкаст, не новое сообщение
  const text = typeof m.text === 'string' ? m.text : '';
  const attaches = Array.isArray(m.attaches) ? m.attaches.filter(a => a && typeof a === 'object') : [];
  const kinds = attaches.map(a => String(a._type || '').toUpperCase());
  if (kinds.includes('CONTROL') || kinds.includes('CALL')) return null;
  const pick = (k) => attaches[kinds.indexOf(k)];
  const media = (kind, extra) => ({ kind, url: null, fileId: null, fileName: null, mimeType: 'application/octet-stream', size: 0, ...extra });
  if (kinds.includes('PHOTO')) {
    const a = pick('PHOTO');
    return { type: 'image', text, media: media('PHOTO', { url: a.baseUrl || null, mimeType: 'image/jpeg' }) };
  }
  if (kinds.includes('FILE')) {
    const a = pick('FILE');
    return { type: 'document', text, media: media('FILE', { fileId: a.fileId !== undefined && a.fileId !== null ? a.fileId : null, fileName: a.name || null, mimeType: mimeOfName(a.name), size: Number(a.size) || 0 }) };
  }
  if (kinds.includes('AUDIO')) {
    const a = pick('AUDIO');
    return { type: 'audio', text, media: a.url ? media('AUDIO', { url: a.url, mimeType: 'audio/ogg' }) : null };
  }
  if (kinds.includes('VIDEO')) return { type: 'video', text, media: null };
  if (kinds.includes('STICKER')) return { type: 'sticker', text, media: null };
  if (kinds.includes('CONTACT')) return { type: 'contact', text, media: null };
  if (!text.trim()) return null;                      // SHARE/пусто без текста — нечего показывать
  return { type: 'text', text, media: null };
}

// message.time — миллисекунды (у Chatpush timestamp был в секундах).
function tsSeconds(time) {
  const n = Number(time);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n > 1e12 ? n / 1000 : n);
}

function replyIdOf(message) {
  const link = message && message.link;
  if (!link || link.type !== 'REPLY') return null;
  const id = (link.message && link.message.id) || link.messageId;
  return id !== undefined && id !== null && id !== '' ? String(id) : null;
}

/**
 * Тело вебхука. peer — собеседник личного диалога ИЛИ отправитель в группе
 * ({id, phone, name}); для исходящего в группу — null. content — уже разобранный
 * contentOf (если медиа скачано, mimeType там фактический), иначе разбирается здесь.
 */
function buildWebhookBody({ accountId, ownPhone, ownerId, chatId, chat, message, peer, deliveryId, fileUrl, content: given }) {
  const content = given || contentOf(message) || { type: 'unsupported', text: '', media: null };
  const group = isGroupChat({ chatId, chat });
  const outgoing = Number(message.sender) === Number(ownerId);
  const p = peer && typeof peer === 'object' ? peer : {};
  const peerPhone = p.phone ? normalizePhone(String(p.phone)) : null;
  const peerName = p.name ? String(p.name) : null;
  const msg = { id: String(message.id), type: content.type, text: content.text, timestamp: tsSeconds(message.time), reply_to_message_id: replyIdOf(message) };
  if (content.media && fileUrl) msg.file_data = { download_url: fileUrl, mime_type: content.media.mimeType, file_name: content.media.fileName, caption: content.text };
  const chatIdOut = group ? String(chatId) : String(p.id !== undefined && p.id !== null ? p.id : xorId(chatId, ownerId));
  const chatName = group ? ((chat && chat.title) || null) : peerName;
  return {
    type: 'max_incoming_msg',
    payload: {
      provider: 'gateway',
      customer_id: accountId,
      instance_id: accountId,
      direction: outgoing ? 'outgoing' : 'incoming',
      chat_id: chatIdOut,
      chat_type: group ? 'group' : 'person',
      chat_name: chatName,
      sender_id: outgoing ? String(ownerId) : String(message.sender),
      sender_name: outgoing ? null : peerName,
      sender_phone_number: outgoing ? (ownPhone || null) : peerPhone,
      recipient_id: outgoing ? chatIdOut : String(ownerId),
      recipient_name: outgoing ? chatName : null,
      recipient_phone_number: outgoing ? (group ? null : peerPhone) : (ownPhone || null),
      delivery_id: deliveryId || null,
      timestamp: msg.timestamp,
      message: msg,
    },
  };
}

module.exports = { xorId, peerIdOf, isGroupChat, isChannel, mimeOfName, contentOf, tsSeconds, replyIdOf, buildWebhookBody, MIME_BY_EXT };
