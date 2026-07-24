'use strict';

const aitunnel = require('../../aitunnel');
const config = require('../../../config');
const { createLogger } = require('../../../logger');
const logger = createLogger('AgentAitunnel');

// ── aitunnel-адаптер: Gemini 3.1 Flash Lite через OpenAI-совместимый API. ──

// Anthropic-схема инструмента → OpenAI function-схема.
function toOpenAITools(schemas) {
  return (schemas || []).map(s => ({
    type: 'function',
    function: { name: s.name, description: s.description, parameters: s.input_schema },
  }));
}

function safeParse(s) {
  try { return JSON.parse(s || '{}'); } catch (_) { return {}; }
}

// Транзиентные сбои провайдера, на которых стоит повторить вызов. Ключевой случай —
// aitunnel HTTP 421 «Не удалось посчитать стоимость запроса, отсутствует поле usage»:
// его billing-прокси иногда не видит usage в ответе Gemini и роняет вполне нормальный
// ход. Повторить вызов LLM безопасно — сам по себе он без побочных эффектов, а запись
// защищена идемпотентностью в booking.js.
function isTransient(err) {
  if (!err) return false;
  const s = err.status;
  if (s === 421 || s === 429 || (s >= 500 && s <= 599)) return true;
  if (/usage|стоимость запроса/i.test(err.message || '')) return true;
  if (/APIConnection/i.test(err.name || '')) return true;
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND'].includes(err.code || '');
}

const MAX_RETRIES = 4;                       // 1 основная попытка + 4 ретрая (aitunnel часто флапает 421/429)
const RETRY_BASE_MS = 400;                   // 400/800/1200/1600мс — короткий бэкофф
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createWithRetry(client, params, o = {}) {
  const maxRetries = o.maxRetries != null ? o.maxRetries : MAX_RETRIES;
  const baseMs = o.retryBaseMs != null ? o.retryBaseMs : RETRY_BASE_MS;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await client.chat.completions.create(params);
    } catch (e) {
      lastErr = e;
      if (attempt === maxRetries || !isTransient(e)) throw e;
      await sleep(baseMs * (attempt + 1));
    }
  }
  throw lastErr;
}

// Вызов chat.completions + нормализация ответа в провайдер-агностичный вид.
async function createMessage({ system, messages, tools }, opts = {}) {
  const client = opts.client || aitunnel.makeClient(opts.apiKey);
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages.slice();
  const primaryModel = opts.model || config.AITUNNEL_CHAT_MODEL;
  const params = {
    model: primaryModel,
    max_tokens: opts.maxTokens || config.AGENT_MAX_TOKENS,
    messages: msgs,
  };
  // Пустой tools API отвергает, поэтому опускаем ключ целиком. Так оркестратор
  // делает добивочный вызов «ответь прозой» — без инструментов модель обязана
  // выдать текст, а не очередной tool_call.
  const openAITools = toOpenAITools(tools);
  if (openAITools.length) params.tools = openAITools;

  // Основная модель со своим ретраем; при персистентном ТРАНЗИЕНТНОМ сбое
  // (aitunnel флапает 421/usage/таймаут подряд) добиваем тот же запрос через
  // надёжную fallback-модель (Claude тем же ключом — usage всегда есть, прокси
  // не рубит на биллинге). Переигровка безопасна: на упавшем ответе tool_calls
  // мы не получили, ничего не выполнилось; гонки create_booking закрыты
  // идемпотентным ключом в booking.js. Инцидент 2026-07-24.
  let resp;
  try {
    resp = await createWithRetry(client, params,
      { maxRetries: opts.maxRetries, retryBaseMs: opts.retryBaseMs });
  } catch (e) {
    const fallbackModel = opts.fallbackModel !== undefined
      ? opts.fallbackModel : config.AITUNNEL_FALLBACK_MODEL;
    if (!isTransient(e) || !fallbackModel || fallbackModel === primaryModel) throw e;
    const fbTimeout = opts.fallbackTimeoutMs || config.AITUNNEL_FALLBACK_TIMEOUT_MS;
    logger.warn(`основная модель ${primaryModel} упала (${e.message}) — fallback на ${fallbackModel}`);
    // Одна попытка: Claude надёжен, свой короткий таймаут — не копить 60+60 с.
    resp = await client.chat.completions.create({ ...params, model: fallbackModel }, { timeout: fbTimeout });
  }
  const choice = (resp.choices && resp.choices[0]) || {};
  const m = choice.message || {};
  const text = (m.content || '').trim();
  const toolCalls = (m.tool_calls || []).map(tc => ({
    id: tc.id, name: tc.function.name, input: safeParse(tc.function.arguments),
  }));
  return { text, toolCalls, stopReason: choice.finish_reason, assistantMsg: m };
}

// Результаты инструментов → по одному {role:'tool'} на вызов (формат OpenAI).
function toolResultMessages(results) {
  return results.map(r => ({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.result) }));
}

module.exports = { createMessage, toolResultMessages, toOpenAITools };
