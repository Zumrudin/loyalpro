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

// Кандидаты форматов номера для матчинга входящего сообщения с clients.phone.
// Входящий телефон приходит без «+» (79200255591), а в базе хранится с «+»
// (+79200255591) — и иногда с «8». Берём последние 10 цифр (ядро мобильного РФ)
// и генерируем варианты префиксов, чтобы искать через ТОЧНОЕ сравнение
// `phone = ANY($candidates)` и попадать в btree-индекс idx_clients_phone
// (salon_id, phone), а не гонять regexp по всей таблице клиентов.
function phoneMatchCandidates(raw) {
  const digits = raw ? String(raw).replace(/\D/g, '') : '';
  if (digits.length < 10) return [];
  const core = digits.slice(-10);
  return [`+7${core}`, `7${core}`, `8${core}`, `+8${core}`, core];
}

module.exports = { dialogKey, isMedia, mediaLabel, messagePreview, phoneMatchCandidates };
