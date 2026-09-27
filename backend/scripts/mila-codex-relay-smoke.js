'use strict';
const assert = require('node:assert/strict');
const provider = require('../services/agent/providers/codex-relay');

async function main() {
  const started = Date.now();
  const system = 'Ты Мила, администратор вымышленного тестового салона. Часы работы узнай через get_test_hours. Отвечай кратко по-русски.';
  const messages = [{ role: 'user', content: 'Во сколько открывается салон?' }];
  const tools = [{ name: 'get_test_hours', description: 'Тестовые часы работы.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } }];
  const first = await provider.createMessage({ system, messages, tools });
  assert.equal(first.toolCalls.length, 1);
  assert.equal(first.toolCalls[0].name, 'get_test_hours');
  messages.push(first.assistantMsg, ...provider.toolResultMessages([{
    id: first.toolCalls[0].id, result: { opens: '10:30', closes: '19:30', synthetic: true },
  }]));
  const last = await provider.createMessage({ system, messages, tools: [] });
  assert.equal(last.toolCalls.length, 0);
  assert.match(last.text, /10:30/);
  console.log(JSON.stringify({ passed: true, model: provider.MODEL, llmCalls: 2, ms: Date.now() - started }));
}
main().catch(e => {
  console.error(JSON.stringify({ passed: false, code: /^RELAY_[A-Z_]+$/.test(e.code || '') ? e.code : 'SMOKE_FAILED' }));
  process.exitCode = 1;
});
