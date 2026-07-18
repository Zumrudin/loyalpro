// ============================================================
// Chatpush Dialog Agent
// ------------------------------------------------------------
// Принимает нормализованное входящее сообщение (из services/chatpush
// parseIncomingMessage) и возвращает ТЕКСТ ответа, либо null — чтобы промолчать.
//
// Сейчас это заглушка для проверки сквозного пути webhook → отправка.
// Сюда подключается LLM: история переписки + вызов Claude/Gemini.
// ============================================================
const { createLogger } = require('../logger');
const logger = createLogger('ChatpushAgent');

/**
 * @param {object} msg  результат chatpush.parseIncomingMessage()
 * @returns {Promise<string|null>}  текст ответа или null (не отвечать)
 */
// Текстовые типы разных каналов: WhatsApp/MAX шлют 'text', tdlib/Telegram — 'formattedText'.
// Оба несут обычный текст в msg.text — отвечаем на любой из них.
const TEXT_TYPES = new Set(['text', 'formattedText']);

async function generateReply(msg) {
  // Пока отвечаем только на текст; файлы/картинки/голос — молча пропускаем.
  if (!TEXT_TYPES.has(msg.type) || !msg.text.trim()) {
    logger.debug(`skip non-text (type=${msg.type}) from ${msg.phone}`);
    return null;
  }

  // ── TODO: настоящий диалоговый агент ───────────────────────────────
  // 1) Подтянуть историю диалога по msg.phone / msg.chatId из БД
  //    (нужна таблица chatpush_messages: salon_id, phone, direction, text, ts).
  // 2) Вызвать LLM. Готовая интеграция уже есть в проекте — см. KB-ассистента
  //    (services/knowledge-base + KB_GEMINI_* в config). Для Claude —
  //    @anthropic-ai/sdk, модель claude-opus-4-8 / claude-sonnet-4-6.
  // 3) Сохранить пару вопрос/ответ, вернуть сгенерированный текст.
  // ───────────────────────────────────────────────────────────────────

  return `Вы написали: «${msg.text.trim()}». Диалоговый агент в разработке — скоро отвечу по существу.`;
}

module.exports = { generateReply };
