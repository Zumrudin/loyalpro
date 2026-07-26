'use strict';

const OpenAI = require('openai');
const config = require('../config');

// ── Общий OpenAI-совместимый клиент к polza.ai ─────────────────
// Используется агентом (services/agent/providers/polza.js). Наценка ~6%,
// оплата картой РФ, модели Anthropic/Google по id вида `anthropic/...`.
// Таймаут обязателен: дефолт SDK — 600 с, и залипший запрос превращается
// в немой диалог на десятки минут (клиент не получает вообще ничего).
// 60 с × 2 ретрая — потолок ожидания ответа агента.
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;

function makeClient(apiKey) {
  return new OpenAI({
    apiKey: apiKey || config.POLZA_API_KEY || 'missing',
    baseURL: config.POLZA_BASE,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });
}

module.exports = { makeClient };
