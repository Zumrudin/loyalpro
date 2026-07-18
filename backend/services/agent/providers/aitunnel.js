'use strict';

const aitunnel = require('../../aitunnel');
const config = require('../../../config');

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

// Вызов chat.completions + нормализация ответа в провайдер-агностичный вид.
async function createMessage({ system, messages, tools }, opts = {}) {
  const client = opts.client || aitunnel.makeClient(opts.apiKey);
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages.slice();
  const resp = await client.chat.completions.create({
    model: opts.model || config.AITUNNEL_CHAT_MODEL,
    max_tokens: opts.maxTokens || config.AGENT_MAX_TOKENS,
    messages: msgs,
    tools: toOpenAITools(tools),
  });
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
