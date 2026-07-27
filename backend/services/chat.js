'use strict';
// ============================================================
// Chat — чистые хелперы форматирования (без БД/HTTP).
// Разделяются routes/chat.js; юнит-тесты в backend/chat.test.js.
// ============================================================

// Групповой chat_id у Telegram/MAX начинается с «-». Групповой диалог должен
// оставаться ОДНИМ тредом: ключ строится от chat_id, номер участника игнорируется
// (иначе сообщения участников с известным номером утекали в их личные диалоги).
function isGroupChatId(chatId) {
  return String(chatId || '').startsWith('-');
}

function isGroupKey(key) {
  return String(key || '').startsWith('g:');
}

// Ключ диалога: группа → 'g:'+chat_id; личный — phone, иначе chat_id.
// Зеркалит DIALOG_KEY_SQL — фронт и бэк одинаково понимают «один диалог».
function dialogKey(row) {
  const chatId = row && row.chat_id ? String(row.chat_id).trim() : '';
  if (isGroupChatId(chatId)) return 'g:' + chatId;
  const phone = row && row.phone ? String(row.phone).trim() : '';
  if (phone) return phone;
  return chatId;
}

// SQL-эквивалент dialogKey — подставляется в запросы routes/chat.js и в
// выражение индекса idx_chatpush_messages_dialogkey2 (migrations.js).
// Менять только синхронно с dialogKey и индексом!
const DIALOG_KEY_SQL =
  `CASE WHEN chat_id LIKE '-%' THEN 'g:' || chat_id
        ELSE COALESCE(NULLIF(phone,''), chat_id) END`;

// Канал для ответа по умолчанию: куда клиент писал в последний раз;
// без входящих — канал последнего сообщения.
function defaultChannel(messages) {
  if (!Array.isArray(messages) || !messages.length) return null;
  const sorted = [...messages].sort((a, b) => (Number(a.msg_ts) || 0) - (Number(b.msg_ts) || 0));
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].direction === 'incoming') return sorted[i].channel || null;
  }
  return sorted[sorted.length - 1].channel || null;
}

// Параметры получателя для chatpush.sendMessage/sendFile.
// tdlib в группу и без номера — по tdlib_user_id; для MAX дублируем max_user_id
// (надёжнее, если номера нет в MAX). null — отправить некуда.
function recipientParams(channel, { phone, chat_id, isGroup } = {}) {
  const p = String(phone || '').trim();
  const c = String(chat_id || '').trim();
  const routing = channel === 'telegram_bot' ? 'telegram' : channel;
  const out = { dispatchRouting: [routing] };
  if (channel === 'tdlib' && (isGroup || !p)) {
    if (!c) return null;
    out.tdlib_user_id = c;
    return out;
  }
  if (p) out.phone = p;
  if ((channel === 'max' || channel === 'max_bot') && c) out.max_user_id = c;
  if (!out.phone && !out.max_user_id) return null;
  return out;
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

module.exports = { dialogKey, isGroupKey, isGroupChatId, DIALOG_KEY_SQL,
  defaultChannel, recipientParams, isMedia, mediaLabel, messagePreview, phoneMatchCandidates };
