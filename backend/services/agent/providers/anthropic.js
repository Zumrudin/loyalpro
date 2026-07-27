'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');

// ── Anthropic-адаптер (Claude tool-calling). Откат: AGENT_PROVIDER=anthropic. ──
function makeClient(apiKey) {
  return new Anthropic({ apiKey: apiKey || config.ANTHROPIC_API_KEY });
}

// Вызов Claude + нормализация ответа в провайдер-агностичный вид.
async function createMessage({ system, messages, tools }, opts = {}) {
  const client = opts.client || makeClient(opts.apiKey);
  const params = {
    model: opts.model || config.AGENT_LLM_MODEL,
    max_tokens: opts.maxTokens || config.AGENT_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    // Кэш-брейкпоинт на системном промпте: с каталогом услуг внутри он большой,
    // итерации tool-цикла и соседние ходы платят кэш-тариф (-90% на чтении).
    system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
    messages,
  };
  // Пустой список — добивочный вызов оркестратора «ответь прозой без инструментов».
  if (tools && tools.length) params.tools = tools;
  const msg = await client.messages.create(params);
  const blocks = (msg && msg.content) || [];
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const toolCalls = blocks
    .filter(b => b.type === 'tool_use')
    .map(b => ({ id: b.id, name: b.name, input: b.input }));
  return { text, toolCalls, stopReason: msg && msg.stop_reason, assistantMsg: { role: 'assistant', content: msg.content } };
}

// Результаты инструментов → один user-turn с tool_result-блоками (формат Anthropic).
function toolResultMessages(results) {
  return [{
    role: 'user',
    content: results.map(r => {
      const block = { type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.result) };
      if (r.isError) block.is_error = true;
      return block;
    }),
  }];
}

module.exports = { makeClient, createMessage, toolResultMessages };
