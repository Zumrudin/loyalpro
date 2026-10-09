'use strict';
// POST события в бэкенд (/gateway/webhook?key=…). Бэкенд для шлюза резолвит
// салон ДО ответа: 200 — принято (дальше обрабатывает асинхронно, как с
// Chatpush), 503 — сбой БД, просит повторить; 401 — неверный секрет, повтор
// бессмыслен. Повторы — на сетевые/5xx ошибки, пауза 500·n мс.
const axios = require('axios');
const { createLogger } = require('../logger');
const logger = createLogger('Webhook');

// Повторяем только то, что может пройти со второй попытки: сеть/таймаут (нет
// ответа), 5xx, 408, 429. Прочие 4xx (401 — неверный секрет, 400, 404…) — не лечатся.
function isRetryable(e) {
  const st = e && e.response && e.response.status;
  if (!st) return true;
  return st >= 500 || st === 408 || st === 429;
}

// Пауза между попытками: бэкенд перезапускается при каждом выкате (pm2 restart
// ≈ 10–20 с), а TDLib апдейт уже отдал — короткие повторы теряли бы входящие.
// Расписание ≈ 2,5 минуты суммарно; очередь чата на это время стоит, порядок
// сохраняется.
const RETRY_DELAYS_MS = [500, 1000, 2000, 5000, 10000, 20000, 30000, 30000, 30000];
const DEFAULT_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
function delayFor(attempt) { return RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]; }

function makeSender({ url, post, sleep, attempts = DEFAULT_ATTEMPTS } = {}) {
  const doPost = post || ((u, body) => axios.post(u, body, { timeout: 10000 }));
  const doSleep = sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  return async function send(body) {
    let lastErr = null;
    for (let i = 1; i <= attempts; i++) {
      try { await doPost(url, body); return; }
      catch (e) {
        lastErr = e;
        if (!isRetryable(e)) throw e;
        if (i < attempts) await doSleep(delayFor(i));
      }
    }
    throw lastErr;
  };
}

let defaultSend = null;
function getDefault() {
  if (!defaultSend) defaultSend = makeSender({ url: require('../config').BACKEND_WEBHOOK_URL });
  return defaultSend;
}

async function send(body) { return getDefault()(body); }
// Обёртка «не бросает»: ошибка логируется с идентификаторами события.
function makeSafe(sendFn, log) {
  return async function sendSafe(body) {
    try { await sendFn(body); }
    catch (e) {
      const p = (body && body.payload) || {};
      const m = p.message || {};
      log.error(`вебхук не доставлен в бэкенд: ${e.message} status=${(e.response && e.response.status) || '-'} acc=${p.customer_id} dir=${p.direction} msg=${m.id} delivery=${p.delivery_id || '-'}`);
    }
  };
}
const sendSafe = makeSafe(send, logger);

module.exports = { makeSender, RETRY_DELAYS_MS, DEFAULT_ATTEMPTS, makeSafe, isRetryable, send, sendSafe };
