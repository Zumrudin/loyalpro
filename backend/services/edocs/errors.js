'use strict';
// Ошибка модуля «Документы» с HTTP-статусом для роутера: code — машинный код
// (фронт по нему открывает «Мой F.Doc» и т.п.), message — текст для человека.
class EdocsError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'EdocsError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}
/** Короткий текст ошибки для журнала и ответа (без переводов строк, до 300 символов). */
function shortError(e) { return String((e && e.message) || e || '').replace(/\s+/g, ' ').trim().slice(0, 300); }

/**
 * Ответ роутера на ошибку модуля. Наружу — только понятный текст и машинный код;
 * текст SQL и стек — в лог (правило проекта для API).
 */
function sendError(res, e, logger, label) {
  if (e && e.name === 'EdocsError') {
    const body = { error: e.message, code: e.code };
    if (e.missing) body.missing = e.missing;
    if (e.packageId) body.packageId = e.packageId;
    return res.status(e.status || 400).json(body);
  }
  if (e && e.name === 'SecretBoxError') {
    if (e.code === 'no_key') {
      return res.status(503).json({ error: 'На сервере не задан ключ шифрования EDOCS_ENC_KEY — обратитесь к администратору сервера', code: 'enc_not_configured' });
    }
    logger.error(`${label}: ${e.message}`);
    return res.status(500).json({ error: 'Не удалось расшифровать сохранённые данные', code: 'enc_failed' });
  }
  if (e && e.name === 'TemplateError') return res.status(400).json({ error: e.message, details: e.details || [] });
  if (e && e.name === 'FdocError') {
    logger.warn(`${label}: ${e.message}`);
    return res.status(502).json({ error: e.message, code: e.code });
  }
  logger.error(`${label}: ${(e && e.message) || e}`);
  return res.status(500).json({ error: 'Внутренняя ошибка' });
}

module.exports = { EdocsError, shortError, sendError };
