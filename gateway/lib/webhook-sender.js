'use strict';
// POST события в бэкенд (/gateway/webhook?key=…). Бэкенд для шлюза резолвит
// салон ДО ответа: 200 — принято (дальше обрабатывает асинхронно, как с
// Chatpush), 503 — сбой БД, просит повторить; 401 — неверный секрет, повтор
// бессмыслен. Повторы — на сетевые/5xx ошибки, пауза 500·n мс.
const axios = require('axios');
const { createLogger } = require('../logger');
const logger = createLogger('Webhook');

function makeSender({ url, post, sleep, attempts = 3 } = {}) {
  const doPost = post || ((u, body) => axios.post(u, body, { timeout: 10000 }));
  const doSleep = sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  return async function send(body) {
    let lastErr = null;
    for (let i = 1; i <= attempts; i++) {
      try { await doPost(url, body); return; }
      catch (e) {
        lastErr = e;
        const st = e.response && e.response.status;
        if (st === 401) throw e;
        if (i < attempts) await doSleep(500 * i);
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
async function sendSafe(body) {
  try { await send(body); }
  catch (e) { logger.error(`вебхук не доставлен в бэкенд: ${e.message} (type=${body && body.type})`); }
}

module.exports = { makeSender, send, sendSafe };
