'use strict';
// ============================================================
// Служебные алерты владельцу/разработчику (Telegram Bot API), rate-limit раз
// в час на ключ. ЗАЧЕМ: 10–11.09.2026 кончился баланс polza.ai (402), Мила
// сутки отвечала «передаю администратору», и об этом не узнал никто — алерта
// не было нигде. В текст НЕ кладём PII: только код ошибки и салон.
// Строго best-effort: notify не бросает; текст ошибки транспорта в лог не
// попадает (axios кладёт в message URL с токеном бота).
// Тесты: ops-alert.test.js (чистая фабрика с инжектированным транспортом).
// ============================================================
const axios = require('axios');
const config = require('../config');
const { createLogger } = require('../logger');

const defaultLog = createLogger('OpsAlert');
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

function isPaymentError(err) {
  if (!err) return false;
  const status = err.status ?? err.statusCode ?? (err.response && err.response.status);
  if (Number(status) === 402) return true;
  const m = String(err.message || '');
  return /^402\b|status code 402\b|:\s*402\b|недостаточно средств|insufficient[\s_-]*(balance|funds|quota|credit)/iu.test(m);
}

function telegramTransport({ token, chatId }) {
  if (!token || !chatId) return null;
  return async (text) => {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text: text.slice(0, 3500), disable_web_page_preview: true },
      { timeout: 8000 });
  };
}

let _unconfiguredWarned = false; // предупреждение «не настроено» — раз на процесс

function createAlerter({ transport, log = defaultLog, nowMs = () => Date.now(), cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const lastSent = new Map();
  let warned = false;
  return {
    /** @returns {Promise<boolean>} ушло ли сообщение; никогда не бросает */
    async notify(key, text) {
      try {
        const now = nowMs();
        const prev = lastSent.get(key);
        if (prev !== undefined && now - prev <= cooldownMs) return false;
        lastSent.set(key, now); // резерв слота: параллельный notify не продублирует
        const line = `[ops-alert ${key}] ${text}`;
        log.error(line);
        if (!transport) {
          if (!warned && !_unconfiguredWarned) {
            warned = _unconfiguredWarned = true;
            log.warn('ops-alert: транспорт алертов не настроен (OPS_ALERT_TELEGRAM_TOKEN/CHAT_ID)');
          }
          return false;
        }
        try {
          await transport(line);
          return true;
        } catch (e) {
          lastSent.delete(key); // неудачная отправка не сжигает час
          // e.message у axios может содержать URL с токеном — логируем только код.
          log.warn(`ops-alert: отправка не удалась (${e && (e.code || (e.response && e.response.status)) || 'error'})`);
          return false;
        }
      } catch (_) { return false; }
    },
  };
}

const defaultAlerter = createAlerter({
  transport: telegramTransport({
    token: config.OPS_ALERT_TELEGRAM_TOKEN, chatId: config.OPS_ALERT_TELEGRAM_CHAT_ID,
  }),
});

module.exports = { createAlerter, isPaymentError, notify: (k, t) => defaultAlerter.notify(k, t) };
