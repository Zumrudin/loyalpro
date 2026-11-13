'use strict';
const axios = require('axios');
const API_BASE = 'https://platform-api2.max.ru';

// No HTTP error object escapes this boundary: axios includes headers, tokens
// and patient content in it. No automatic retries of POSTs with unknown outcome.
function createApi(token, http = axios) {
  async function request(method, path, data, params) {
    try {
      const r = await http.request({ method, url: API_BASE + path, data, params,
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        timeout: 15000, maxRedirects: 0 });
      if (r.data?.success === false) throw new Error('MAX rejected request');
      return r.data;
    } catch (err) {
      const e = new Error('MAX API request failed');
      e.status = Number.isInteger(err.response?.status) ? err.response.status : null;
      throw e;
    }
  }
  return {
    send: (userId, body) => request('POST', '/messages', body, { user_id: userId }),
    me: () => request('GET', '/me'),
    commands: () => request('PATCH', '/me/commands', { commands: [
      { name: 'start', description: 'Регистрация в программе лояльности' },
      { name: 'balance', description: 'Бонусный баланс и кешбэк' },
      { name: 'cancel', description: 'Отменить ввод анкеты' },
      { name: 'help', description: 'Помощь' },
    ] }),
    subscribe: (url, secret) => request('POST', '/subscriptions', {
      url, secret, update_types: ['bot_started', 'bot_stopped', 'message_created'],
    }),
    subscriptions: () => request('GET', '/subscriptions'),
  };
}
module.exports = { createApi, API_BASE };
