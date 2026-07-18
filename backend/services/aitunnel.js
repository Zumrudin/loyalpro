'use strict';

const OpenAI = require('openai');
const config = require('../config');

// ── Общий OpenAI-совместимый клиент к aitunnel.ru ──────────────
// Используется агентом (services/agent/providers/aitunnel.js) и базой знаний.
// baseURL/ключ из config; apiKey можно переопределить (тесты/мультиаккаунт).
function makeClient(apiKey) {
  return new OpenAI({
    apiKey: apiKey || config.AITUNNEL_API_KEY || 'missing',
    baseURL: config.AITUNNEL_BASE,
  });
}

module.exports = { makeClient };
