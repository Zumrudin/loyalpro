'use strict';
// ============================================================
// Групповые чаты — Мила в них МОЛЧИТ.
// ------------------------------------------------------------
// Агент ведёт переписку только ЛИЧНО с клиентом. В групповых чатах (рабочие
// группы салона, чаты с несколькими участниками, служебные рассылки) автоответ
// не запускается вовсе. Сообщения по-прежнему сохраняются и видны на странице
// «Чат» — отвечает там только живой человек.
//
// Зачем нужен именно гейт, а не «оно и так не сработает»: в группе Chatpush
// присылает chat_id группы И номер УЧАСТНИКА (проверено на живых данных tdlib:
// chat_id=-1003759304044, phone=79202577754). Ключ диалога у диспетчера —
// `phone || chat_id`, поэтому сообщение из группы попадало в ЛИЧНЫЙ диалог
// этого участника: Мила читала его личный транскрипт и слала ответ ему в личку.
//
// Почему отдельный модуль, а не services/chat.isGroupChatId: тот хелпер зеркалит
// DIALOG_KEY_SQL и выражение индекса idx_chatpush_messages_dialogkey2 — расширять
// его нельзя без пересборки индекса. Здесь гейт бота, и он намеренно ШИРЕ
// (fail-safe: сомнение → считаем групповым и молчим).
// ============================================================

/**
 * Похож ли идентификатор на групповой чат. Запасной путь для случаев, когда
 * Chatpush не прислал chat_type (WhatsApp) или проверяется голый ключ диалога.
 *  • tdlib/MAX — групповой chat_id начинается с «-» (супергруппа: -100…);
 *  • WhatsApp — групповой jid оканчивается на «@g.us», статусы/рассылки — «@broadcast»
 *    (личный — «…@c.us», такой групповым НЕ считается);
 *  • «g:…» — ключ диалога админки (services/chat.dialogKey), на случай вызова
 *    диспетчера ключом из UI.
 */
function isGroupChatId(chatId) {
  const id = String(chatId === undefined || chatId === null ? '' : chatId).trim();
  if (!id) return false;
  if (id.startsWith('-') || id.startsWith('g:')) return true;
  return /@(g\.us|broadcast)$/i.test(id);
}

// Значения chat_type, означающие ЛИЧНУЮ переписку. Всё остальное непустое
// (group, supergroup, channel, …) считаем групповым — fail-safe в пользу молчания.
const PRIVATE_CHAT_TYPES = new Set(['person', 'private', 'user', 'direct']);

/**
 * Сообщение из группы? Принимает camelCase (chatpush.parseMessageEvent) и snake_case (строка БД).
 * Приоритет — явный chat_type от Chatpush (tdlib/MAX шлют 'person'|'group'; на живых
 * данных он совпадает с «-» в chat_id 1-в-1). WhatsApp chat_type не шлёт вовсе —
 * там работает разбор jid.
 */
function isGroupMessage(msg) {
  if (!msg) return false;
  const type = String(msg.chatType ?? msg.chat_type ?? '').trim().toLowerCase();
  if (type) return !PRIVATE_CHAT_TYPES.has(type);
  return isGroupChatId(msg.chatId ?? msg.chat_id);
}

module.exports = { isGroupChatId, isGroupMessage, PRIVATE_CHAT_TYPES };
