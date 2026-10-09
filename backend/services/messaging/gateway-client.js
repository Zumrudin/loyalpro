'use strict';
// Внутренний API шлюза (gateway/server.js, /internal/*). Секрет — заголовок
// X-Gateway-Secret. Контракт:
//   POST /internal/accounts/:id/start  → {authState}
//   POST /internal/accounts/:id/auth   body {phone}|{code}|{password} → {authState, error}
//   GET  /internal/accounts/:id/status → {authState, phone, displayName, error}
//   POST /internal/accounts/:id/logout → {ok:true}
// authState: starting|wait_phone|wait_code|wait_password|ready|logged_out|error
const axios = require('axios');
const config = require('../../config');

function base() {
  const url = (config.MESSAGING_GATEWAY && config.MESSAGING_GATEWAY.url) || '';
  if (!url) { const e = new Error('шлюз мессенджеров не настроен (MESSAGING_GATEWAY_URL)'); e.status = 503; throw e; }
  return url.replace(/\/+$/, '');
}
function headers() { return { 'X-Gateway-Secret': config.MESSAGING_GATEWAY.secret || '' }; }

async function call(method, path, body) {
  const url = `${base()}${path}`;     // base() бросает 503 ДО запроса
  try {
    const { data } = await axios({ method, url, data: body, headers: headers(), timeout: 20000 });
    return data;
  } catch (e) {
    const st = e.response && e.response.status;
    const msg = (e.response && e.response.data && e.response.data.error) || e.message;
    const err = new Error(`шлюз: ${msg}`); err.status = st || 502; throw err;
  }
}

module.exports = {
  start:  (id) => call('post', `/internal/accounts/${id}/start`),
  auth:   (id, step) => call('post', `/internal/accounts/${id}/auth`, step),
  status: (id) => call('get',  `/internal/accounts/${id}/status`),
  logout: (id) => call('post', `/internal/accounts/${id}/logout`),
};
