'use strict';
// ============================================================
// Chat — чистые хелперы форматирования (без БД/HTTP).
// Разделяются routes/chat.js; юнит-тесты в backend/chat.test.js.
// ============================================================

// Ключ диалога: сначала phone, иначе chat_id. Зеркалит SQL-выражение
// COALESCE(NULLIF(phone,''), chat_id) в routes/chat.js — фронт и бэк
// одинаково понимают «один диалог».
function dialogKey(row) {
  const phone = row && row.phone ? String(row.phone).trim() : '';
  if (phone) return phone;
  return row && row.chat_id ? String(row.chat_id) : '';
}

// Медиа (вложение), а не текст? Текстовые типы chatpush: text, formattedText.
function isMedia(msgType) {
  const t = String(msgType || '').toLowerCase();
  if (!t) return false;
  return !t.includes('text');
}

// Человекочитаемая метка (RU) для вложения, с эмодзи-скрепкой.
function mediaLabel(msgType) {
  const t = String(msgType || '').toLowerCase();
  if (t.includes('image') || t.includes('photo')) return '📎 Фото';
  if (t.includes('video')) return '📎 Видео';
  if (t.includes('audio') || t.includes('voice')) return '📎 Аудио';
  if (t.includes('document') || t.includes('file')) return '📎 Документ';
  return '📎 Вложение';
}

// Однострочный превью для списка диалогов: текст для текстовых сообщений,
// метка вложения — для медиа.
function messagePreview(msg) {
  if (!msg) return '';
  if (isMedia(msg.msg_type)) return mediaLabel(msg.msg_type);
  return String(msg.text || '').trim();
}

module.exports = { dialogKey, isMedia, mediaLabel, messagePreview };
