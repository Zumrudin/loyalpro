'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../config');

// ── Клиент Claude для tool-calling диалога. Тонкая обёртка над Messages API. ──
// Спека: docs/superpowers/specs/2026-07-18-ai-booking-agent-design.md ([4]).

function makeClient(apiKey) {
  return new Anthropic({ apiKey: apiKey || config.ANTHROPIC_API_KEY });
}

// Один вызов Claude с инструментами. Возвращает сырой message (content + stop_reason).
// opts.client — для тестов (мок SDK); иначе создаётся из ANTHROPIC_API_KEY.
async function createMessage({ system, messages, tools }, opts = {}) {
  const client = opts.client || makeClient(opts.apiKey);
  return client.messages.create({
    model: opts.model || config.AGENT_LLM_MODEL,
    max_tokens: opts.maxTokens || config.AGENT_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    system,
    tools,
    messages,
  });
}

// Разбор ответа: склеенный текст + tool_use-блоки + stop_reason.
function splitContent(message) {
  const blocks = (message && message.content) || [];
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const toolUses = blocks.filter(b => b.type === 'tool_use');
  return { text, toolUses, stopReason: message && message.stop_reason };
}

// Строит user-блок tool_result для ответа модели. result сериализуется в JSON-строку.
function toolResultBlock(toolUseId, result, isError = false) {
  const block = {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: JSON.stringify(result),
  };
  if (isError) block.is_error = true;
  return block;
}

module.exports = { makeClient, createMessage, splitContent, toolResultBlock };
