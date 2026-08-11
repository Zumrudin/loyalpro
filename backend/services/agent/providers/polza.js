'use strict';

const polza = require('../../polza');
const config = require('../../../config');
const { createLogger } = require('../../../logger');
const logger = createLogger('AgentPolza');

// ── polza.ai-адаптер: Claude через OpenAI-совместимый API (наценка ~6%). ──
// Структурно копия providers/aitunnel.js (решение из плана миграции 2026-07-25):
// другой base URL/ключ и id моделей вида `anthropic/claude-sonnet-4.6`.

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

// Транзиентные сбои, на которых повторить вызов безопасно: сам вызов LLM без
// побочных эффектов, а запись защищена идемпотентностью в booking.js.
// 529 — «overloaded» Anthropic, Polza пробрасывает его как есть.
function isTransient(err) {
  if (!err) return false;
  const s = err.status;
  if (s === 429 || (s >= 500 && s <= 599)) return true;
  if (/APIConnection/i.test(err.name || '')) return true;
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND'].includes(err.code || '');
}

const MAX_RETRIES = 3;                       // 1 основная попытка + 3 ретрая
const RETRY_BASE_MS = 400;                   // 400/800/1200мс — короткий бэкофф
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
  const client = opts.client || polza.makeClient(opts.apiKey);
  // system уходит content-массивом с cache_control (формат OpenRouter): на моделях
  // с прямым anthropic-роутом (sonnet-5) Polza кэширует префикс system+tools —
  // замер 2026-07-26: повторный вызов 0.16 ₽ вместо 1.36 ₽. Azure-роут (sonnet-4.6)
  // формат принимает и молча игнорирует кэш — безвредно.
  const msgs = system
    ? [{ role: 'system', content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] }, ...messages]
    : messages.slice();
  const primaryModel = opts.model || config.POLZA_CHAT_MODEL;
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

  // Потолок «размышлений». ЗАЧЕМ: у gemini-2.5-pro reasoning занимал 95% всего
  // output'а при 54 токенах видимого пациенту текста — ~57% счёта уходило на то,
  // чего никто не читает (замер scripts/agent-model-benchmark.js, 2026-08-11).
  // Ограничение до 512 дало ту же модель вдвое дешевле и вдвое быстрее при
  // идентичных ответах. opts.reasoningMaxTokens — для пробников и бенчмарка.
  const reasoningCap = opts.reasoningMaxTokens !== undefined
    ? opts.reasoningMaxTokens : config.POLZA_REASONING_MAX_TOKENS;
  if (reasoningCap > 0) params.reasoning = { max_tokens: reasoningCap };

  // Основная модель со своим ретраем; при персистентном ТРАНЗИЕНТНОМ сбое
  // добиваем тот же запрос через fallback-модель. Переигровка безопасна:
  // на упавшем ответе tool_calls мы не получили, ничего не выполнилось;
  // гонки create_booking закрыты идемпотентным ключом в booking.js.
  let resp;
  try {
    resp = await createWithRetry(client, params,
      { maxRetries: opts.maxRetries, retryBaseMs: opts.retryBaseMs });
  } catch (e) {
    const fallbackModel = opts.fallbackModel !== undefined
      ? opts.fallbackModel : config.POLZA_FALLBACK_MODEL;
    if (!isTransient(e) || !fallbackModel || fallbackModel === primaryModel) throw e;
    const fbTimeout = opts.fallbackTimeoutMs || config.POLZA_FALLBACK_TIMEOUT_MS;
    logger.warn(`основная модель ${primaryModel} упала (${e.message}) — fallback на ${fallbackModel}`);
    // Одна попытка со своим коротким таймаутом — не копить 60+60 с.
    // reasoning на fallback НЕ переносим: ручка проверена только на vertex-роутах
    // Gemini, а запасная модель — Anthropic, где бюджет размышлений живёт по своим
    // правилам (на 5.x он удалён и отдаёт 400). Цена ошибки — отказ ровно в тот
    // момент, когда основная модель уже упала, то есть fallback'а не будет вовсе.
    const { reasoning: _noReasoningOnFallback, ...fbParams } = params;
    resp = await client.chat.completions.create({ ...fbParams, model: fallbackModel }, { timeout: fbTimeout });
  }
  // Polza кладёт в usage реальные списания (cost_rub) — логируем каждый ход,
  // чтобы дорогую модель было видно в логах, а не только по кошельку
  // (урок инцидента с reasoning-токенами aitunnel 2026-07-25).
  const u = resp.usage || {};
  if (u.cost_rub != null) {
    const reasoning = (u.completion_tokens_details || {}).reasoning_tokens || 0;
    const cached = (u.prompt_tokens_details || {}).cached_tokens || 0;
    logger.info(`${resp.model || primaryModel}: ${u.cost_rub} ₽ (in=${u.prompt_tokens} out=${u.completion_tokens} reasoning=${reasoning} cached=${cached})`);
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
