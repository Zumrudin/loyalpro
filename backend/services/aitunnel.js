'use strict';

const OpenAI = require('openai');
const config = require('../config');

// ── Общий OpenAI-совместимый клиент к aitunnel.ru ──────────────
// Используется агентом (services/agent/providers/aitunnel.js) и базой знаний.
// baseURL/ключ из config; apiKey можно переопределить (тесты/мультиаккаунт).
// Таймаут обязателен: дефолт SDK — 600 с, и залипший запрос превращается
// в немой диалог на десятки минут (клиент не получает вообще ничего).
// 60 с × 2 ретрая — потолок ожидания ответа агента.
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;

function makeClient(apiKey) {
  return new OpenAI({
    apiKey: apiKey || config.AITUNNEL_API_KEY || 'missing',
    baseURL: config.AITUNNEL_BASE,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });
}

module.exports = { makeClient };
